"""
GlueCron adapter — implements `CodeHost` against gluecron.com.

GlueCron is our GitHub-equivalent code host. Per the published spec:
  - REST API at https://gluecron.com/api/v2  (Bearer PAT auth, glc_ / glcron_)
  - Workflow runner reads .gluecron/workflows/*.yml (vs .github/workflows on GitHub)
  - Raw file URLs at https://gluecron.com/<owner>/<repo>/raw/<ref>/<path>
  - Triggers: on: push (branches), on: schedule, on: workflow_dispatch

GlueCron is described as an "operator-tier replacement for GitHub" — its
REST surface mirrors GitHub's resource layout closely. Where the spec is
explicit (raw URLs, workflow paths, auth) we use those exact shapes;
where the spec only enumerates resources without payload schemas we
ASSUME GitHub-compatible REST shapes and mark them with `# ASSUMED:`
comments so they're easy to verify or correct.

Configuration via env (settings.gluecron_api_url / .gluecron_raw_base):
  defaults to the hosted gluecron.com endpoints; override for self-host.

Tokens: per-request (passed by the caller). Same model as the GitHub
adapter — accepts the user's PAT in the existing `github_token` /
`gluecron_github_token` slots in the request body, no schema change
needed in the frontend or callers.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import re
import zipfile
from typing import Any

import httpx

from .base import CodeHost

# Per the spec, GlueCron's workflow files live at .gluecron/workflows/
WORKFLOW_DIR = ".gluecron/workflows"


class GlueCronCodeHost(CodeHost):
    name = "gluecron"

    def __init__(
        self,
        api_url:  str | None = None,
        raw_base: str | None = None,
    ) -> None:
        from core.config import get_settings
        s = get_settings()
        # Strip trailing slashes for clean joins.
        self.api_url  = (api_url  or s.gluecron_api_url ).rstrip("/")
        self.raw_base = (raw_base or s.gluecron_raw_base).rstrip("/")

    # ── HTTP plumbing ─────────────────────────────────────────────────────

    def _headers(self, token: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {token}",
            "Accept":        "application/json",
            "Content-Type":  "application/json",
            "User-Agent":    "Holden Mercer / GlueCron adapter",
        }

    async def _client(self) -> httpx.AsyncClient:
        # Returned to caller as `async with await self._client() as c:` —
        # the caller is responsible for closing.
        return httpx.AsyncClient(timeout=30.0)

    # ── Files ─────────────────────────────────────────────────────────────

    async def get_file(self, repo: str, path: str, ref: str | None, token: str) -> str:
        """Fetch via the documented raw URL. Per the spec:
            https://gluecron.com/<owner>/<repo>/raw/<ref>/<path>
        """
        if "/" not in repo:
            raise ValueError("repo must be in 'owner/name' form.")
        if not token:
            raise ValueError("No GlueCron PAT configured.")
        ref_resolved = ref or "HEAD"
        url = f"{self.raw_base}/{repo}/raw/{ref_resolved}/{path.lstrip('/')}"
        async with httpx.AsyncClient(timeout=30.0) as c:
            r = await c.get(url, headers=self._headers(token))
        if r.status_code == 404:
            return f"[not found: {repo}/{path}{f'@{ref}' if ref else ''}]"
        if r.status_code >= 400:
            return f"[error: {r.status_code} {r.text[:300]}]"
        if len(r.content) > 200_000:
            return f"[refused: {len(r.content)} bytes, over 200 KB cap]"
        try:
            return r.text
        except UnicodeDecodeError:
            return "[refused: file is binary]"

    async def put_file(
        self, repo: str, path: str, content: str,
        commit_message: str, branch: str | None, token: str,
    ) -> str:
        """ASSUMED: GitHub-compatible Contents API at
            PUT  /api/v2/repos/{owner}/{repo}/contents/{path}
        with body { message, content (base64), branch?, sha? (when
        overwriting) }.
        """
        if "/" not in repo:
            raise ValueError("repo must be in 'owner/name' form.")
        if not path:
            raise ValueError("path is required.")
        if not token:
            raise ValueError("No GlueCron PAT configured.")

        url = f"{self.api_url}/repos/{repo}/contents/{path.lstrip('/')}"
        async with httpx.AsyncClient(timeout=30.0) as c:
            # Resolve existing SHA so we can overwrite cleanly.
            head_params = {"ref": branch} if branch else None
            head = await c.get(url, headers=self._headers(token), params=head_params)
            sha = head.json().get("sha") if head.status_code == 200 else None

            body: dict[str, Any] = {
                "message": commit_message,
                "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
            }
            if sha:    body["sha"]    = sha
            if branch: body["branch"] = branch

            r = await c.put(url, headers=self._headers(token), json=body)
        if r.status_code >= 400:
            return f"[error: {r.status_code} {r.text[:300]}]"
        data    = r.json()
        commit  = data.get("commit", {}).get("sha", "")
        action  = "updated" if sha else "created"
        ref_lbl = branch or "default branch"
        return f"{action} {repo}/{path} on {ref_lbl}  ({len(content)} bytes, commit {commit[:7]})"

    async def delete_file(
        self, repo: str, path: str, commit_message: str,
        branch: str | None, token: str,
    ) -> str:
        """ASSUMED: GitHub-compatible delete via
            DELETE /api/v2/repos/{owner}/{repo}/contents/{path}
        with body { message, sha, branch? }.
        """
        if "/" not in repo:
            raise ValueError("repo must be in 'owner/name' form.")
        if not path:
            raise ValueError("path is required.")
        if not token:
            raise ValueError("No GlueCron PAT configured.")
        url = f"{self.api_url}/repos/{repo}/contents/{path.lstrip('/')}"
        async with httpx.AsyncClient(timeout=30.0) as c:
            head_params = {"ref": branch} if branch else None
            head = await c.get(url, headers=self._headers(token), params=head_params)
            if head.status_code == 404:
                return f"[not found: {repo}/{path}]"
            head.raise_for_status()
            sha = head.json().get("sha")
            if not sha:
                return f"[error: could not resolve SHA for {repo}/{path}]"
            body: dict[str, Any] = {"message": commit_message, "sha": sha}
            if branch: body["branch"] = branch
            r = await c.request("DELETE", url, headers=self._headers(token), json=body)
        if r.status_code >= 400:
            return f"[error: {r.status_code} {r.text[:300]}]"
        commit = r.json().get("commit", {}).get("sha", "")
        return f"deleted {repo}/{path} on {branch or 'default branch'}  (commit {commit[:7]})"

    async def list_dir(
        self, repo: str, path: str, ref: str | None, token: str,
    ) -> list[dict]:
        """ASSUMED: GET /api/v2/repos/{owner}/{repo}/contents/{path}?ref=
        Returns array of { name, path, type ('file'|'dir'), size, sha,
        html_url } when path is a directory; returns object for a file.
        """
        if "/" not in repo:
            raise ValueError("repo must be in 'owner/name' form.")
        if not token:
            raise ValueError("No GlueCron PAT configured.")
        url = f"{self.api_url}/repos/{repo}/contents/{path.lstrip('/')}"
        params = {"ref": ref} if ref else None
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.get(url, headers=self._headers(token), params=params)
        if r.status_code == 404:
            return []
        r.raise_for_status()
        data = r.json()
        return [data] if isinstance(data, dict) else (data or [])

    # ── Repos ─────────────────────────────────────────────────────────────

    async def list_repos(self, org: str, token: str) -> list[dict]:
        """ASSUMED: GET /api/v2/users/{user}/repos and
        GET /api/v2/orgs/{org}/repos with GitHub-compatible listing.
        """
        if not token:
            raise ValueError("No GlueCron PAT configured.")
        if not org:
            raise ValueError("GlueCron user/org is required.")
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.get(
                f"{self.api_url}/users/{org}/repos",
                headers=self._headers(token),
                params={"per_page": 100, "sort": "updated"},
            )
            if r.status_code == 404:
                r = await c.get(
                    f"{self.api_url}/orgs/{org}/repos",
                    headers=self._headers(token),
                    params={"per_page": 100, "sort": "updated"},
                )
            r.raise_for_status()
            return r.json() or []

    async def default_branch(self, repo: str, token: str) -> str:
        """ASSUMED: GET /api/v2/repos/{owner}/{repo} returns
        { default_branch, ... } as on GitHub.
        """
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.get(f"{self.api_url}/repos/{repo}", headers=self._headers(token))
            r.raise_for_status()
            return r.json().get("default_branch", "main")

    # ── Branches ──────────────────────────────────────────────────────────

    async def create_branch(
        self, repo: str, branch: str, from_ref: str | None, token: str,
    ) -> str:
        """ASSUMED: GitHub-shaped git refs API:
            GET  /api/v2/repos/{repo}/git/refs/heads/{ref}
            POST /api/v2/repos/{repo}/git/refs  with { ref: refs/heads/<branch>, sha }
        """
        if "/" not in repo:
            raise ValueError("repo must be in 'owner/name' form.")
        if not branch:
            raise ValueError("branch is required.")
        if not token:
            raise ValueError("No GlueCron PAT configured.")
        async with httpx.AsyncClient(timeout=20.0) as c:
            if not from_ref:
                from_ref = await self.default_branch(repo, token)
            r = await c.get(
                f"{self.api_url}/repos/{repo}/git/refs/heads/{from_ref}",
                headers=self._headers(token),
            )
            if r.status_code == 404:
                r2 = await c.get(
                    f"{self.api_url}/repos/{repo}/commits/{from_ref}",
                    headers=self._headers(token),
                )
                r2.raise_for_status()
                base_sha = r2.json().get("sha")
            else:
                r.raise_for_status()
                base_sha = r.json().get("object", {}).get("sha")
            if not base_sha:
                return f"[error: could not resolve SHA for {from_ref}]"
            create = await c.post(
                f"{self.api_url}/repos/{repo}/git/refs",
                headers=self._headers(token),
                json={"ref": f"refs/heads/{branch}", "sha": base_sha},
            )
            if create.status_code == 422:
                return f"[branch already exists: {branch}]"
            if create.status_code >= 400:
                return f"[error: {create.status_code} {create.text[:300]}]"
        return f"created branch {branch} in {repo} from {from_ref} ({base_sha[:7]})"

    async def commit_changes(
        self, repo: str, files: list[dict], commit_message: str,
        branch: str | None, token: str,
    ) -> str:
        """ASSUMED: GitHub-compatible git Trees API for atomic multi-file commits:
            GET  /api/v2/repos/{repo}/git/refs/heads/{branch}
            GET  /api/v2/repos/{repo}/git/commits/{sha}
            POST /api/v2/repos/{repo}/git/blobs    with { content, encoding }
            POST /api/v2/repos/{repo}/git/trees    with { base_tree, tree }
            POST /api/v2/repos/{repo}/git/commits  with { message, tree, parents }
            PATCH /api/v2/repos/{repo}/git/refs/heads/{branch}  with { sha }
        """
        if "/" not in repo:
            raise ValueError("repo must be in 'owner/name' form.")
        if not files:
            raise ValueError("files list is required.")
        if not token:
            raise ValueError("No GlueCron PAT configured.")

        async with httpx.AsyncClient(timeout=60.0) as c:
            target = branch or await self.default_branch(repo, token)
            ref = await c.get(
                f"{self.api_url}/repos/{repo}/git/refs/heads/{target}",
                headers=self._headers(token),
            )
            if ref.status_code == 404:
                return f"[branch not found: {target}]"
            ref.raise_for_status()
            head_sha = ref.json()["object"]["sha"]
            head_commit = await c.get(
                f"{self.api_url}/repos/{repo}/git/commits/{head_sha}",
                headers=self._headers(token),
            )
            head_commit.raise_for_status()
            base_tree_sha = head_commit.json()["tree"]["sha"]

            tree_entries: list[dict] = []
            writes = deletes = 0
            for f in files:
                fpath  = (f.get("path") or "").lstrip("/")
                action = (f.get("action") or "update").lower()
                if not fpath:
                    return "[error: file entry missing 'path']"
                if action == "delete":
                    deletes += 1
                    tree_entries.append({"path": fpath, "mode": "100644", "type": "blob", "sha": None})
                    continue
                content = f.get("content") or ""
                blob = await c.post(
                    f"{self.api_url}/repos/{repo}/git/blobs",
                    headers=self._headers(token),
                    json={"content": content, "encoding": "utf-8"},
                )
                if blob.status_code >= 400:
                    return f"[error creating blob for {fpath}: {blob.status_code} {blob.text[:200]}]"
                tree_entries.append({
                    "path": fpath, "mode": "100644", "type": "blob",
                    "sha":  blob.json()["sha"],
                })
                writes += 1

            new_tree = await c.post(
                f"{self.api_url}/repos/{repo}/git/trees",
                headers=self._headers(token),
                json={"base_tree": base_tree_sha, "tree": tree_entries},
            )
            if new_tree.status_code >= 400:
                return f"[tree error: {new_tree.status_code} {new_tree.text[:300]}]"
            new_tree_sha = new_tree.json()["sha"]

            new_commit = await c.post(
                f"{self.api_url}/repos/{repo}/git/commits",
                headers=self._headers(token),
                json={"message": commit_message, "tree": new_tree_sha, "parents": [head_sha]},
            )
            if new_commit.status_code >= 400:
                return f"[commit error: {new_commit.status_code} {new_commit.text[:300]}]"
            new_sha = new_commit.json()["sha"]

            update = await c.patch(
                f"{self.api_url}/repos/{repo}/git/refs/heads/{target}",
                headers=self._headers(token),
                json={"sha": new_sha, "force": False},
            )
            if update.status_code >= 400:
                return f"[ref update error: {update.status_code} {update.text[:300]}]"

        return (
            f"committed {writes} write(s) + {deletes} delete(s) to "
            f"{repo}@{target} as {new_sha[:7]} — \"{commit_message}\""
        )

    # ── Pull requests ─────────────────────────────────────────────────────

    async def open_pull_request(
        self, repo: str, head: str, base: str | None,
        title: str, body: str, token: str,
    ) -> str:
        """ASSUMED: POST /api/v2/repos/{repo}/pulls with
            { head, base, title, body }
        Returns { number, html_url }.
        """
        if "/" not in repo:
            raise ValueError("repo must be in 'owner/name' form.")
        if not head or not title:
            raise ValueError("head and title are required.")
        if not token:
            raise ValueError("No GlueCron PAT configured.")
        async with httpx.AsyncClient(timeout=30.0) as c:
            target = base or await self.default_branch(repo, token)
            r = await c.post(
                f"{self.api_url}/repos/{repo}/pulls",
                headers=self._headers(token),
                json={"head": head, "base": target, "title": title, "body": body or ""},
            )
        if r.status_code >= 400:
            return f"[error: {r.status_code} {r.text[:300]}]"
        d = r.json()
        number = d.get("number")
        url    = d.get("html_url") or f"{self.raw_base}/{repo}/pulls/{number}"
        return (
            f"opened PR #{number} in {repo} ({head} → {target}) — {title}\n  {url}"
        )

    async def merge_pull_request(
        self, repo: str, pull_number: int, merge_method: str, token: str,
    ) -> str:
        """ASSUMED: GET /api/v2/repos/{repo}/pulls/{n} returns
            { merged, state, head: { sha, ref }, base: { ref } }
        and PUT /api/v2/repos/{repo}/pulls/{n}/merge accepts
            { merge_method }.

        Gate-protection is enforced here by checking the latest
        Holden Mercer gate workflow run for the head SHA — same
        guarantee as the GitHub adapter.
        """
        if "/" not in repo:
            raise ValueError("repo must be in 'owner/name' form.")
        if not pull_number:
            raise ValueError("pull_number is required.")
        if not token:
            raise ValueError("No GlueCron PAT configured.")
        if merge_method not in ("squash", "merge", "rebase"):
            merge_method = "squash"

        from api.gate_workflow import WORKFLOW_FILENAME

        async with httpx.AsyncClient(timeout=30.0) as c:
            pr = await c.get(
                f"{self.api_url}/repos/{repo}/pulls/{pull_number}",
                headers=self._headers(token),
            )
            if pr.status_code == 404:
                return f"[PR #{pull_number} not found in {repo}]"
            pr.raise_for_status()
            p = pr.json()
            head_sha = p.get("head", {}).get("sha", "")
            head_ref = p.get("head", {}).get("ref", "")
            base_ref = p.get("base", {}).get("ref", "")
            if p.get("merged"):
                return f"[PR #{pull_number} is already merged]"
            if p.get("state") == "closed":
                return f"[PR #{pull_number} is closed (not merged)]"

            # Gate-check
            run = await self.latest_run_for_sha(repo, WORKFLOW_FILENAME, head_sha, token)
            if run is None:
                return (
                    f"[REFUSED: no gate run found for head SHA {head_sha[:7]}. "
                    f"Trigger run_gate(repo={repo!r}, branch={head_ref!r}) first.]"
                )
            if run.get("status") != "completed":
                return f"[REFUSED: gate run {run.get('id')} still {run.get('status')!r} on {head_sha[:7]}]"
            if run.get("conclusion") != "success":
                return (
                    f"[REFUSED: gate run {run.get('id')} concluded "
                    f"{run.get('conclusion')!r} — main never receives red commits.]"
                )

            merge = await c.put(
                f"{self.api_url}/repos/{repo}/pulls/{pull_number}/merge",
                headers=self._headers(token),
                json={"merge_method": merge_method},
            )
        if merge.status_code == 405:
            return f"[error: PR not mergeable — possible conflicts with {base_ref}]"
        if merge.status_code == 409:
            return f"[error: head SHA changed mid-merge; re-fetch PR and retry]"
        if merge.status_code >= 400:
            return f"[error: {merge.status_code} {merge.text[:300]}]"
        m = merge.json()
        return (
            f"merged PR #{pull_number} ({head_ref} → {base_ref}) via {merge_method} — "
            f"{m.get('sha', '')[:7]}. Gate was ✅ on {head_sha[:7]}."
        )

    # ── Search ────────────────────────────────────────────────────────────

    async def search_code(self, repo: str, query: str, token: str) -> str:
        """GlueCron's GraphQL exposes a `search` root. v1 path: prefer the
        REST search endpoint if exposed; the spec lists `repository` and
        `search` GraphQL roots, so we use the GraphQL endpoint for code
        search.

        ASSUMED: a `searchCode(query: String!, repo: String): [SearchHit]`
        field on the search root with { path, html_url, snippet } hits.
        """
        if not query.strip():
            raise ValueError("query is required.")
        if not token:
            raise ValueError("No GlueCron PAT configured.")
        gql_url = self.api_url.rsplit("/", 1)[0] + "/graphql"   # /api/v2 → /api/graphql
        gql_query = """
        query Q($repo: String, $q: String!) {
          search { code(query: $q, repo: $repo) { path htmlUrl snippet } }
        }
        """
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.post(
                gql_url, headers=self._headers(token),
                json={"query": gql_query, "variables": {"repo": repo, "q": query}},
            )
        if r.status_code >= 400:
            return f"[error: {r.status_code} {r.text[:200]}]"
        try:
            hits = (((r.json() or {}).get("data") or {}).get("search") or {}).get("code") or []
        except Exception:
            hits = []
        if not hits:
            return f"[no matches for {query!r} in {repo}]"
        rows = [f"{len(hits)} match(es) for {query!r} in {repo}:", ""]
        for h in hits[:25]:
            rows.append(f"• {h.get('path','?')}")
            if h.get("htmlUrl"): rows.append(f"  {h['htmlUrl']}")
            sn = (h.get("snippet") or "").strip()
            if sn:
                short = "\n    ".join(sn.splitlines()[:6])
                rows.append(f"    {short}")
            rows.append("")
        return "\n".join(rows).rstrip()

    # ── CI / workflows ────────────────────────────────────────────────────

    async def install_workflow(
        self, repo: str, filename: str, content: str,
        branch: str | None, token: str,
    ) -> str:
        """GlueCron workflows live under .gluecron/workflows/ per the spec."""
        return await self.put_file(
            repo=repo, path=f"{WORKFLOW_DIR}/{filename}",
            content=content,
            commit_message=f"chore(workflow): install {filename}",
            branch=branch, token=token,
        )

    async def dispatch_workflow(
        self, repo: str, filename: str, ref: str,
        inputs: dict[str, str], token: str,
    ) -> str:
        """ASSUMED: GitHub-shaped POST
            /api/v2/repos/{repo}/actions/workflows/{filename}/dispatches
        body { ref, inputs? }. Spec confirms `on: workflow_dispatch` is
        a supported trigger.
        """
        url = (
            f"{self.api_url}/repos/{repo}/actions/workflows/"
            f"{filename}/dispatches"
        )
        body: dict[str, Any] = {"ref": ref}
        if inputs: body["inputs"] = inputs
        async with httpx.AsyncClient(timeout=30.0) as c:
            r = await c.post(url, headers=self._headers(token), json=body)
        if r.status_code == 404:
            return f"[workflow not installed: {filename}]"
        if r.status_code >= 400:
            return f"[dispatch failed: {r.status_code} {r.text[:300]}]"
        return f"dispatched {filename} on {ref}"

    async def list_workflow_runs(
        self, repo: str, filename: str, params: dict | None, token: str,
    ) -> dict:
        """ASSUMED: GET /api/v2/repos/{repo}/actions/workflows/{filename}/runs
        returns { workflow_runs: [...] } — GitHub-compatible.
        """
        url = (
            f"{self.api_url}/repos/{repo}/actions/workflows/"
            f"{filename}/runs"
        )
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.get(url, headers=self._headers(token), params=params or {})
        if r.status_code == 404:
            return {"workflow_installed": False, "workflow_runs": []}
        r.raise_for_status()
        data = r.json()
        data.setdefault("workflow_installed", True)
        return data

    async def get_workflow_run(self, repo: str, run_id: int | str, token: str) -> dict | None:
        """ASSUMED: GET /api/v2/repos/{repo}/actions/runs/{run_id}"""
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.get(
                f"{self.api_url}/repos/{repo}/actions/runs/{run_id}",
                headers=self._headers(token),
            )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    async def get_workflow_logs(self, repo: str, run_id: int | str, token: str) -> str:
        """GlueCron streams logs live via SSE at
            /<owner>/<repo>/actions/<run>/stream
        For our use case (post-failure tail) we need the static archive.

        ASSUMED: GET /api/v2/repos/{repo}/actions/runs/{run_id}/logs returns
        a zip archive of per-step .txt logs (GitHub-compatible).
        """
        url = f"{self.api_url}/repos/{repo}/actions/runs/{run_id}/logs"
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as c:
            r = await c.get(url, headers=self._headers(token))
        if r.status_code == 404:
            return f"[logs not available for run {run_id}]"
        if r.status_code >= 400:
            return f"[error: {r.status_code} {r.text[:300]}]"
        try:
            with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
                txt_files = [n for n in zf.namelist() if n.endswith(".txt")]
                if not txt_files:
                    return "[no .txt logs in archive]"
                blobs = []
                for name in txt_files:
                    with zf.open(name) as f:
                        text = f.read().decode("utf-8", errors="replace")
                        blobs.append(f"\n────────  {name}  ────────\n{text}")
            full = "".join(blobs)
        except zipfile.BadZipFile:
            return "[response was not a valid zip archive]"
        if len(full) > 120_000:
            full = "[…truncated…]\n" + full[-120_000:]
        return full

    async def latest_run_for_sha(
        self, repo: str, filename: str, head_sha: str, token: str,
    ) -> dict | None:
        data = await self.list_workflow_runs(
            repo, filename, {"head_sha": head_sha, "per_page": 1}, token,
        )
        runs = data.get("workflow_runs") or []
        return runs[0] if runs else None

    # ── Provider deep-links ───────────────────────────────────────────────

    def secrets_setup_url(self, repo: str) -> str:
        # Per the spec, repo settings live at /<owner>/<repo>/settings/...
        # Webhooks confirmed at /settings/webhooks; secrets URL is ASSUMED
        # to follow the GitHub convention.
        return f"{self.raw_base}/{repo}/settings/secrets/actions/new"
