"""
Infrastructure Bridge — GlueCron native memory + CronTech deployments.

GlueCron repos are treated as "Native Memory":
  - Indexed into Supabase pgvector (text-embedding-3-small)
  - Searchable by semantic query for any voice command

CronTech deployment:
  - Triggered via REST API (configure CRONTECH_API_URL + CRONTECH_API_KEY)
  - Shadow Architect loop: auto-debug up to 5 iterations on failure

Shadow Architect loop flow:
  code → validate → if fail → Claude debug → apply fix → validate (repeat ≤5x)

SETUP: Run migrations/001_gluecron_embeddings.sql in your Supabase SQL editor
       before calling index_repos() or semantic_search().
"""

from __future__ import annotations

import json
import logging
import subprocess
import textwrap
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

import httpx

from core.config import get_settings
from core.resiliency import resilient_create

logger = logging.getLogger(__name__)
_settings = get_settings()

_GITHUB_API = "https://api.github.com"
_EMBED_MODEL = "text-embedding-3-small"


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class RepoFile:
    repo: str
    path: str
    content: str
    sha: str


@dataclass
class SearchResult:
    repo: str
    path: str
    snippet: str
    similarity: float


@dataclass
class DeploymentResult:
    deployment_id: str
    instance_name: str
    status: str          # "queued" | "running" | "succeeded" | "failed"
    url: str | None
    logs: list[str] = field(default_factory=list)


@dataclass
class ShadowLoopResult:
    success: bool
    iterations: int
    final_code: str
    debug_log: list[str]
    error: str | None = None


# ---------------------------------------------------------------------------
# GlueCron client — GitHub as native memory
# ---------------------------------------------------------------------------

class GlueCronClient:
    """Wraps GitHub API to read repos belonging to the GlueCron org/user."""

    def __init__(self) -> None:
        token = _settings.gluecron_github_token
        org   = _settings.gluecron_github_org
        if not token or not org:
            raise RuntimeError(
                "GLUECRON_GITHUB_TOKEN and GLUECRON_GITHUB_ORG must be set."
            )
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        self._org = org

    def list_repos(self, max_repos: int = 50) -> list[dict]:
        """Return repo metadata for every repo in the org/user."""
        url = f"{_GITHUB_API}/users/{self._org}/repos"
        with httpx.Client(headers=self._headers, timeout=30) as c:
            resp = c.get(url, params={"per_page": max_repos, "sort": "updated"})
            resp.raise_for_status()
        return resp.json()

    def get_tree(self, repo: str, branch: str = "HEAD") -> list[dict]:
        """Return the recursive file tree for a repo."""
        url = f"{_GITHUB_API}/repos/{self._org}/{repo}/git/trees/{branch}"
        with httpx.Client(headers=self._headers, timeout=30) as c:
            resp = c.get(url, params={"recursive": "1"})
            resp.raise_for_status()
        return resp.json().get("tree", [])

    def get_file(self, repo: str, path: str) -> RepoFile | None:
        """Fetch decoded file content. Returns None for binaries / oversized files."""
        url = f"{_GITHUB_API}/repos/{self._org}/{repo}/contents/{path}"
        with httpx.Client(headers=self._headers, timeout=30) as c:
            resp = c.get(url)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
        data = resp.json()
        if data.get("encoding") != "base64":
            return None
        import base64
        content = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
        return RepoFile(repo=repo, path=path, content=content, sha=data["sha"])

    def iter_text_files(
        self,
        repo: str,
        extensions: tuple[str, ...] = (".py", ".ts", ".tsx", ".js", ".jsx", ".md", ".json"),
        max_files: int = 200,
    ) -> Iterator[RepoFile]:
        """Yield text files from a repo, skipping binaries and node_modules."""
        skip_prefixes = ("node_modules/", ".git/", "dist/", "build/", "__pycache__/")
        tree = self.get_tree(repo)
        count = 0
        for item in tree:
            if item["type"] != "blob":
                continue
            p = item["path"]
            if any(p.startswith(s) for s in skip_prefixes):
                continue
            if not any(p.endswith(e) for e in extensions):
                continue
            f = self.get_file(repo, p)
            if f:
                yield f
                count += 1
                if count >= max_files:
                    break


# ---------------------------------------------------------------------------
# CronTech deployment client
# ---------------------------------------------------------------------------

class CronTechClient:
    """
    Wraps the CronTech deployment API.

    TODO: Update the endpoint paths once you share the CronTech API spec.
    Current assumption:
      POST  /v1/deployments           — trigger deploy
      GET   /v1/deployments/{id}      — check status
      GET   /v1/instances             — list running instances
    """

    def __init__(self) -> None:
        url = _settings.crontech_api_url
        key = _settings.crontech_api_key
        if not url or not key:
            raise RuntimeError(
                "CRONTECH_API_URL and CRONTECH_API_KEY must be set."
            )
        self._base = url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def deploy(
        self,
        repo: str,
        instance_name: str,
        env_vars: dict[str, str] | None = None,
        dry_run: bool = True,
    ) -> DeploymentResult:
        """
        Trigger a deployment.  dry_run=True logs the intent without calling the API.
        """
        if dry_run:
            logger.info("[DRY RUN] Would deploy repo=%s as instance=%s", repo, instance_name)
            return DeploymentResult(
                deployment_id="dry-run",
                instance_name=instance_name,
                status="dry_run",
                url=None,
                logs=["Dry run — set dry_run=False to execute."],
            )

        payload = {"repo": repo, "instance_name": instance_name, "env": env_vars or {}}
        with httpx.Client(headers=self._headers, timeout=60) as c:
            resp = c.post(f"{self._base}/v1/deployments", json=payload)
            resp.raise_for_status()
        data = resp.json()
        return DeploymentResult(
            deployment_id=data.get("id", ""),
            instance_name=instance_name,
            status=data.get("status", "queued"),
            url=data.get("url"),
        )

    def get_status(self, deployment_id: str) -> DeploymentResult:
        with httpx.Client(headers=self._headers, timeout=30) as c:
            resp = c.get(f"{self._base}/v1/deployments/{deployment_id}")
            resp.raise_for_status()
        data = resp.json()
        return DeploymentResult(
            deployment_id=deployment_id,
            instance_name=data.get("instance_name", ""),
            status=data.get("status", "unknown"),
            url=data.get("url"),
            logs=data.get("logs", []),
        )

    def list_instances(self) -> list[dict]:
        with httpx.Client(headers=self._headers, timeout=30) as c:
            resp = c.get(f"{self._base}/v1/instances")
            resp.raise_for_status()
        return resp.json()

    def poll_until_done(
        self, deployment_id: str, timeout: int = 300, interval: int = 5
    ) -> DeploymentResult:
        """Block until deployment reaches a terminal state or timeout."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = self.get_status(deployment_id)
            if result.status in ("succeeded", "failed", "error"):
                return result
            time.sleep(interval)
        return DeploymentResult(
            deployment_id=deployment_id,
            instance_name="",
            status="timeout",
            url=None,
            logs=["Timed out waiting for deployment."],
        )


# ---------------------------------------------------------------------------
# pgvector semantic search (Supabase)
# ---------------------------------------------------------------------------

def _get_embedding(text: str) -> list[float]:
    """Embed text using OpenAI text-embedding-3-small."""
    if not _settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY must be set for semantic search.")
    import openai
    client = openai.OpenAI(api_key=_settings.openai_api_key)
    text = text.replace("\n", " ")[:8000]   # token budget
    resp = client.embeddings.create(model=_EMBED_MODEL, input=text)
    return resp.data[0].embedding


def index_repos(repos: list[str] | None = None, batch_size: int = 50) -> dict:
    """
    Embed all text files from GlueCron repos and upsert into Supabase
    gluecron_embeddings table (requires pgvector extension — see migration).

    Args:
        repos: specific repo names to index; None = index all repos.
    """
    from supabase import create_client
    gc = GlueCronClient()
    sb = create_client(_settings.supabase_url, _settings.supabase_key)

    all_repos = repos or [r["name"] for r in gc.list_repos()]
    indexed = 0
    errors: list[str] = []

    for repo_name in all_repos:
        logger.info("Indexing repo: %s", repo_name)
        rows: list[dict] = []

        for f in gc.iter_text_files(repo_name):
            try:
                embedding = _get_embedding(f.content[:6000])
                rows.append({
                    "repo": repo_name,
                    "path": f.path,
                    "sha": f.sha,
                    "content_snippet": f.content[:500],
                    "embedding": embedding,
                    "source": "GlueCron",
                })
            except Exception as exc:
                errors.append(f"{repo_name}/{f.path}: {exc}")
                continue

            if len(rows) >= batch_size:
                sb.table("gluecron_embeddings").upsert(
                    rows, on_conflict="repo,path"
                ).execute()
                indexed += len(rows)
                rows = []

        if rows:
            sb.table("gluecron_embeddings").upsert(
                rows, on_conflict="repo,path"
            ).execute()
            indexed += len(rows)

    logger.info("Indexed %d files across %d repos", indexed, len(all_repos))
    return {"indexed": indexed, "repos": len(all_repos), "errors": errors}


def semantic_search(query: str, top_k: int = 5, repo_filter: str | None = None) -> list[SearchResult]:
    """
    Find the most semantically similar code files to the query.
    Uses the pgvector cosine distance RPC defined in the migration.
    """
    from supabase import create_client
    sb = create_client(_settings.supabase_url, _settings.supabase_key)

    query_vec = _get_embedding(query)

    params: dict[str, Any] = {"query_embedding": query_vec, "match_count": top_k}
    if repo_filter:
        params["filter_repo"] = repo_filter

    rpc = "match_gluecron_files"
    if repo_filter:
        rpc = "match_gluecron_files_by_repo"

    resp = sb.rpc(rpc, params).execute()

    return [
        SearchResult(
            repo=r["repo"],
            path=r["path"],
            snippet=r["content_snippet"],
            similarity=r["similarity"],
        )
        for r in (resp.data or [])
    ]


# ---------------------------------------------------------------------------
# Shadow Architect — autonomous debug loop (max 5 iterations)
# ---------------------------------------------------------------------------

_DEBUG_SYSTEM = textwrap.dedent("""\
    You are the Shadow Architect, an expert software engineer performing
    autonomous self-healing on failing code.

    You receive:
      1. The original task description
      2. The current code that failed
      3. The exact error output

    Return ONLY the corrected code — no explanations, no markdown fences,
    no preamble. The raw code will be written directly to disk and re-tested.
""")


def shadow_architect_loop(
    task: str,
    initial_code: str,
    validator: Callable[[str], tuple[bool, str]],
    max_iterations: int = 5,
    on_iteration: Callable[[int, str, str], None] | None = None,
) -> ShadowLoopResult:
    """
    Autonomous debug loop.

    Args:
        task:            Original task description (context for Claude).
        initial_code:    Starting code to validate and potentially fix.
        validator:       callable(code) → (success: bool, output: str)
                         Run your tests / linter here.
        max_iterations:  Hard cap — never exceeds 5 regardless of argument.
        on_iteration:    Optional callback(iteration, code, error) for streaming UI.

    Returns:
        ShadowLoopResult with success flag, iteration count, final code, and log.
    """
    max_iterations = min(max_iterations, 5)  # hard cap
    code = initial_code
    debug_log: list[str] = []

    for i in range(1, max_iterations + 1):
        ok, output = validator(code)
        debug_log.append(f"[iter {i}] validator={'PASS' if ok else 'FAIL'}")

        if ok:
            logger.info("Shadow Architect: passed on iteration %d", i)
            return ShadowLoopResult(
                success=True,
                iterations=i,
                final_code=code,
                debug_log=debug_log,
            )

        debug_log.append(f"[iter {i}] error: {output[:500]}")
        logger.warning("Shadow Architect iter %d: FAIL — asking Claude to fix", i)

        if on_iteration:
            on_iteration(i, code, output)

        if i == max_iterations:
            break   # don't waste an LLM call on the last failed round

        # Ask Claude to fix the code
        try:
            response = resilient_create(
                model="claude-sonnet-4-6",
                messages=[
                    {
                        "role": "user",
                        "content": (
                            f"Task: {task}\n\n"
                            f"Current code:\n```\n{code}\n```\n\n"
                            f"Error output:\n```\n{output}\n```\n\n"
                            "Fix the code. Return ONLY the corrected code."
                        ),
                    }
                ],
                system=_DEBUG_SYSTEM,
                max_tokens=8192,
            )
            if hasattr(response, "content"):
                code = response.content[0].text.strip()
            else:
                code = response["content"][0]["text"].strip()
            debug_log.append(f"[iter {i}] Claude produced fix ({len(code)} chars)")
        except Exception as exc:
            debug_log.append(f"[iter {i}] Claude call failed: {exc}")
            break

    return ShadowLoopResult(
        success=False,
        iterations=max_iterations,
        final_code=code,
        debug_log=debug_log,
        error=f"Failed after {max_iterations} iterations.",
    )


def subprocess_validator(command: str) -> Callable[[str], tuple[bool, str]]:
    """
    Returns a validator that writes code to a temp file and runs ``command``.
    The command may include {code_file} placeholder; if absent, code is piped.

    Example:
        validator = subprocess_validator("python {code_file}")
        ok, out = validator("print('hello')")
    """
    def _validate(code: str) -> tuple[bool, str]:
        import tempfile, os
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(code)
            tmp = f.name
        try:
            cmd = command.replace("{code_file}", tmp) if "{code_file}" in command else command
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=30
            )
            output = result.stdout + result.stderr
            return result.returncode == 0, output
        finally:
            os.unlink(tmp)
    return _validate


# ---------------------------------------------------------------------------
# Convenience: find-and-deploy best landing page (voice command example)
# ---------------------------------------------------------------------------

def find_and_deploy_best(
    query: str,
    instance_name: str,
    dry_run: bool = True,
) -> dict:
    """
    Semantic search → pick best file → deploy to CronTech.

    Example voice command: "Find the best version of my landing page from GlueCron
    and deploy it to a new CronTech instance."
    """
    results = semantic_search(query, top_k=3)
    if not results:
        return {"error": "No matching files found in GlueCron index."}

    best = results[0]
    logger.info(
        "Best match: %s/%s (similarity=%.3f)", best.repo, best.path, best.similarity
    )

    crontech = CronTechClient()
    deploy_result = crontech.deploy(
        repo=best.repo,
        instance_name=instance_name,
        dry_run=dry_run,
    )

    return {
        "best_match": {"repo": best.repo, "path": best.path, "similarity": best.similarity},
        "deployment": {
            "id": deploy_result.deployment_id,
            "status": deploy_result.status,
            "url": deploy_result.url,
        },
    }


# ---------------------------------------------------------------------------
# GlueCron Committer — write files back to GitHub repos
# ---------------------------------------------------------------------------

@dataclass
class CommitResult:
    repo: str
    path: str
    sha: str          # new blob SHA after commit
    commit_sha: str
    branch: str
    url: str          # GitHub web URL to the committed file


class GlueCronCommitter:
    """
    Writes files to GlueCron repos via the GitHub Contents API.

    Uses the same PAT as GlueCronClient but requires repo:write scope.
    All writes default to the staging branch (configurable via GLUECRON_STAGING).

    Usage:
        committer = GlueCronCommitter()
        result = committer.write_file(
            repo="my-app",
            path="src/landing.html",
            content="<html>…</html>",
            message="feat: update landing page via Sovereign AI",
        )
    """

    def __init__(self) -> None:
        token = _settings.gluecron_github_token
        org   = _settings.gluecron_github_org
        if not token or not org:
            raise RuntimeError(
                "GLUECRON_GITHUB_TOKEN (write scope) and GLUECRON_GITHUB_ORG must be set."
            )
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        self._org = org

    def _get_branch(self, repo: str) -> str:
        """Return the target branch — 'staging' or 'main' depending on config."""
        if _settings.gluecron_staging:
            # Ensure staging branch exists; create from HEAD if not
            self._ensure_branch(repo, "staging")
            return "staging"
        return "main"

    def _ensure_branch(self, repo: str, branch: str) -> None:
        """Create branch from HEAD if it doesn't exist. Idempotent."""
        url = f"{_GITHUB_API}/repos/{self._org}/{repo}/git/refs/heads/{branch}"
        with httpx.Client(headers=self._headers, timeout=15) as c:
            resp = c.get(url)
            if resp.status_code == 200:
                return  # branch already exists
            # Get HEAD SHA to branch from
            head = c.get(f"{_GITHUB_API}/repos/{self._org}/{repo}/git/refs/heads/main")
            head.raise_for_status()
            head_sha = head.json()["object"]["sha"]
            # Create branch
            create = c.post(
                f"{_GITHUB_API}/repos/{self._org}/{repo}/git/refs",
                json={"ref": f"refs/heads/{branch}", "sha": head_sha},
            )
            if create.status_code not in (201, 422):  # 422 = already exists (race)
                create.raise_for_status()

    def _get_existing_sha(self, repo: str, path: str, branch: str) -> str | None:
        """Return the blob SHA of an existing file, or None if it doesn't exist."""
        url = f"{_GITHUB_API}/repos/{self._org}/{repo}/contents/{path}"
        with httpx.Client(headers=self._headers, timeout=15) as c:
            resp = c.get(url, params={"ref": branch})
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json().get("sha")

    def write_file(
        self,
        repo: str,
        path: str,
        content: str,
        message: str = "chore: update via Sovereign AI",
        branch: str | None = None,
    ) -> CommitResult:
        """
        Create or update a file in a GlueCron repo.

        Args:
            repo:    Repository name (within the configured org).
            path:    File path inside the repo, e.g. "src/index.ts".
            content: Raw file content (UTF-8 string).
            message: Commit message.
            branch:  Target branch. Defaults to 'staging' or 'main' per config.
        """
        import base64
        target_branch = branch or self._get_branch(repo)
        existing_sha  = self._get_existing_sha(repo, path, target_branch)

        encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
        payload: dict = {
            "message": message,
            "content": encoded,
            "branch":  target_branch,
        }
        if existing_sha:
            payload["sha"] = existing_sha   # required for updates

        url = f"{_GITHUB_API}/repos/{self._org}/{repo}/contents/{path}"
        with httpx.Client(headers=self._headers, timeout=30) as c:
            resp = c.put(url, json=payload)
            resp.raise_for_status()

        data       = resp.json()
        file_data  = data["content"]
        commit_data = data["commit"]

        logger.info(
            "GlueCron commit: %s/%s → %s (branch=%s)",
            repo, path, commit_data["sha"][:8], target_branch,
        )
        return CommitResult(
            repo=repo,
            path=path,
            sha=file_data["sha"],
            commit_sha=commit_data["sha"],
            branch=target_branch,
            url=file_data["html_url"],
        )

    def write_files(
        self,
        repo: str,
        files: dict[str, str],
        message: str = "chore: batch update via Sovereign AI",
        branch: str | None = None,
    ) -> list[CommitResult]:
        """
        Write multiple files to the same repo.
        Each file gets its own commit (GitHub Contents API limitation).
        For atomic multi-file commits use the Git Trees API instead.
        """
        target_branch = branch or self._get_branch(repo)
        results = []
        for path, content in files.items():
            result = self.write_file(
                repo=repo,
                path=path,
                content=content,
                message=f"{message}: {path}",
                branch=target_branch,
            )
            results.append(result)
        return results
