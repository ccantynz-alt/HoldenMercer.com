"""
Console tools — read-only for PR B.

Three tools wired up:
  web_fetch        — fetch any URL, return text content (truncated)
  read_github_file — read a single file from any GitHub repo
  list_github_repos— list repos for the configured GlueCron org/user

All tools use the user's GitHub PAT (per-request override or env-configured
GLUECRON_GITHUB_TOKEN). Web fetch is unauthenticated — public pages only.

PR C will add write tools (write_github_file, commit, run_actions).
"""

from __future__ import annotations

import asyncio
import logging
import re

import httpx

logger = logging.getLogger(__name__)

WEB_FETCH_MAX_BYTES = 200_000      # ~200 KB — enough for most pages, keeps Claude context sane
GITHUB_FILE_MAX_BYTES = 200_000    # same — refuse oversized blobs
GITHUB_API = "https://api.github.com"
GITHUB_RAW = "https://raw.githubusercontent.com"
USER_AGENT = "HoldenMercer.com Builder Console"


# ── Tool schemas (Anthropic format) ─────────────────────────────────────────

TOOL_SCHEMAS: dict[str, dict] = {
    "web_fetch": {
        "name": "web_fetch",
        "description": (
            "Fetch the content of any public web page or HTML/text URL. Use this when "
            "the user pastes a URL or asks you to look at an external page. Returns the "
            "raw text content, truncated to ~200 KB."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Absolute URL starting with http:// or https://",
                },
            },
            "required": ["url"],
        },
    },
    "read_github_file": {
        "name": "read_github_file",
        "description": (
            "Read a single file from a GitHub repository. Use this to understand any of "
            "the user's projects, look up how something was solved in another repo, or "
            "fetch reference code. Works on any repo the configured token has access to."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo": {
                    "type": "string",
                    "description": "Repository in 'owner/name' form, e.g. 'ccantynz-alt/holdenmercer.com'",
                },
                "path": {
                    "type": "string",
                    "description": "Path to the file within the repo, e.g. 'frontend/src/App.jsx'",
                },
                "ref": {
                    "type": "string",
                    "description": "Optional branch or commit SHA. Defaults to the repo's default branch.",
                },
            },
            "required": ["repo", "path"],
        },
    },
    "list_github_repos": {
        "name": "list_github_repos",
        "description": (
            "List up to 100 repositories owned by the configured GitHub user/org. Use this "
            "to discover which projects exist before reading files from them."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "search": {
                    "type": "string",
                    "description": "Optional case-insensitive substring filter on repo name.",
                },
            },
        },
    },
    "list_github_dir": {
        "name": "list_github_dir",
        "description": (
            "List the contents of a directory in a GitHub repository (file/dir names + sizes). "
            "Use this before reading files to discover what's in a directory. "
            "Pass an empty path to list the repo root."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo": {
                    "type": "string",
                    "description": "Repository in 'owner/name' form.",
                },
                "path": {
                    "type": "string",
                    "description": "Directory path relative to repo root. Empty string = root.",
                },
                "ref": {
                    "type": "string",
                    "description": "Optional branch or SHA. Defaults to the repo's default branch.",
                },
            },
            "required": ["repo"],
        },
    },
    "write_github_file": {
        "name": "write_github_file",
        "description": (
            "Create or overwrite a single file in a GitHub repository, producing a real commit. "
            "Use this to make actual changes to the user's project. The whole file must be "
            "supplied — partial edits are not supported. Always read the file first if it might "
            "exist so your write doesn't overwrite work the user wanted to keep."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":           { "type": "string", "description": "Repository in 'owner/name' form." },
                "path":           { "type": "string", "description": "File path within the repo." },
                "content":        { "type": "string", "description": "Full file content as a UTF-8 string." },
                "commit_message": {
                    "type": "string",
                    "description": "Concise present-tense commit message, e.g. 'add contact form'.",
                },
                "branch": {
                    "type": "string",
                    "description": "Optional target branch. Defaults to the repo's default branch.",
                },
            },
            "required": ["repo", "path", "content", "commit_message"],
        },
    },
    "delete_github_file": {
        "name": "delete_github_file",
        "description": (
            "Delete a single file from a GitHub repository, producing a real commit. "
            "Use sparingly — destructive. Always confirm with the user before deleting "
            "files unless they explicitly asked you to remove something."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":           { "type": "string", "description": "Repository in 'owner/name' form." },
                "path":           { "type": "string", "description": "File path within the repo." },
                "commit_message": { "type": "string", "description": "Why you're deleting it." },
                "branch":         { "type": "string", "description": "Optional target branch." },
            },
            "required": ["repo", "path", "commit_message"],
        },
    },
    "create_github_branch": {
        "name": "create_github_branch",
        "description": (
            "Create a new branch in a GitHub repository, branched off another ref. Useful when "
            "you want to make changes on a working branch instead of committing directly to main."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":     { "type": "string", "description": "Repository in 'owner/name' form." },
                "branch":   { "type": "string", "description": "Name of the new branch." },
                "from_ref": {
                    "type": "string",
                    "description": "Branch or SHA to branch off. Defaults to the repo's default branch.",
                },
            },
            "required": ["repo", "branch"],
        },
    },
}


# Tools that mutate state. Used by api/console.py to gate them behind
# autonomy modes (manual mode = read-only).
WRITE_TOOL_NAMES: set[str] = {
    "write_github_file",
    "delete_github_file",
    "create_github_branch",
}


# ── Dispatcher ──────────────────────────────────────────────────────────────

async def run_tool(
    name: str,
    tool_input: dict,
    github_token: str,
    github_org: str,
) -> str:
    """Run a tool by name. Returns plain text Claude can consume."""
    if name == "web_fetch":
        return await _web_fetch(tool_input.get("url", ""))
    if name == "list_github_dir":
        return await _list_github_dir(
            repo=tool_input.get("repo", ""),
            path=tool_input.get("path", ""),
            ref=tool_input.get("ref"),
            token=github_token,
        )
    if name == "write_github_file":
        return await _write_github_file(
            repo=tool_input.get("repo", ""),
            path=tool_input.get("path", ""),
            content=tool_input.get("content", ""),
            commit_message=tool_input.get("commit_message", "Update via Holden Mercer"),
            branch=tool_input.get("branch"),
            token=github_token,
        )
    if name == "delete_github_file":
        return await _delete_github_file(
            repo=tool_input.get("repo", ""),
            path=tool_input.get("path", ""),
            commit_message=tool_input.get("commit_message", "Delete via Holden Mercer"),
            branch=tool_input.get("branch"),
            token=github_token,
        )
    if name == "create_github_branch":
        return await _create_github_branch(
            repo=tool_input.get("repo", ""),
            branch=tool_input.get("branch", ""),
            from_ref=tool_input.get("from_ref"),
            token=github_token,
        )
    if name == "read_github_file":
        return await _read_github_file(
            repo=tool_input.get("repo", ""),
            path=tool_input.get("path", ""),
            ref=tool_input.get("ref"),
            token=github_token,
        )
    if name == "list_github_repos":
        return await _list_github_repos(
            search=tool_input.get("search"),
            token=github_token,
            org=github_org,
        )
    raise ValueError(f"Unknown tool: {name}")


# ── web_fetch ───────────────────────────────────────────────────────────────

async def _web_fetch(url: str) -> str:
    if not url or not re.match(r"^https?://", url):
        raise ValueError("URL must be absolute (start with http:// or https://).")

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=20.0,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        content_type = resp.headers.get("content-type", "")

        # Refuse binary content — Claude can't do anything useful with bytes
        if not _is_textish(content_type):
            return f"[refused: content-type {content_type!r} is not text-ish]"

        text = resp.text
        if len(text) > WEB_FETCH_MAX_BYTES:
            text = text[:WEB_FETCH_MAX_BYTES] + "\n…[truncated]"

        if "html" in content_type.lower():
            text = _strip_html_chrome(text)

        return text


# ── read_github_file ────────────────────────────────────────────────────────

async def _read_github_file(repo: str, path: str, ref: str | None, token: str) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not path:
        raise ValueError("path is required.")
    if not token:
        raise ValueError(
            "No GitHub token configured. Add a GitHub PAT in Settings (or set "
            "GLUECRON_GITHUB_TOKEN in the backend env)."
        )

    headers = {
        "Authorization":         f"Bearer {token}",
        "Accept":                "application/vnd.github.raw",
        "X-GitHub-Api-Version":  "2022-11-28",
        "User-Agent":            USER_AGENT,
    }
    params = {"ref": ref} if ref else None
    url    = f"{GITHUB_API}/repos/{repo}/contents/{path}"

    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(url, headers=headers, params=params)
        if resp.status_code == 404:
            return f"[not found: {repo}/{path}{f'@{ref}' if ref else ''}]"
        resp.raise_for_status()

        if len(resp.content) > GITHUB_FILE_MAX_BYTES:
            return (
                f"[refused: {repo}/{path} is {len(resp.content)} bytes, over "
                f"{GITHUB_FILE_MAX_BYTES} byte limit]"
            )
        try:
            return resp.text
        except UnicodeDecodeError:
            return "[refused: file is binary]"


# ── list_github_repos ───────────────────────────────────────────────────────

async def _fetch_github_repos(token: str, org: str) -> list[dict]:
    """Returns the raw JSON repo objects (used by both the tool and the repo proxy API)."""
    if not token:
        raise ValueError("No GitHub token configured.")
    if not org:
        raise ValueError(
            "No GlueCron org configured. Add GLUECRON_GITHUB_ORG to the backend env."
        )

    headers = _gh_headers(token)
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(
            f"{GITHUB_API}/users/{org}/repos",
            headers=headers,
            params={"per_page": 100, "sort": "updated"},
        )
        if resp.status_code == 404:
            resp = await client.get(
                f"{GITHUB_API}/orgs/{org}/repos",
                headers=headers,
                params={"per_page": 100, "sort": "updated"},
            )
        resp.raise_for_status()
        return resp.json()


async def _list_github_repos(search: str | None, token: str, org: str) -> str:
    repos = await _fetch_github_repos(token, org)

    needle = (search or "").lower().strip()
    rows = []
    for r in repos:
        name = r.get("name", "")
        if needle and needle not in name.lower():
            continue
        rows.append(
            f"- {r.get('full_name')}  "
            f"({'private' if r.get('private') else 'public'})  "
            f"— {r.get('description') or 'no description'}  "
            f"[updated {r.get('updated_at', '')}]"
        )

    if not rows:
        return f"[no repos matched search={needle!r} in org {org!r}]"
    return "\n".join(rows)


# ── list_github_dir ─────────────────────────────────────────────────────────

async def _fetch_github_dir(repo: str, path: str, ref: str | None, token: str) -> list[dict]:
    """Returns the raw JSON listing (or an empty list for 404)."""
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not token:
        raise ValueError("No GitHub token configured.")

    headers = _gh_headers(token)
    params  = {"ref": ref} if ref else None
    url     = f"{GITHUB_API}/repos/{repo}/contents/{path.lstrip('/')}"

    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(url, headers=headers, params=params)
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, dict):
            return [data]
        return data


async def _list_github_dir(repo: str, path: str, ref: str | None, token: str) -> str:
    items = await _fetch_github_dir(repo, path, ref, token)
    if not items:
        return f"[not found: {repo}/{path or '(root)'}{f'@{ref}' if ref else ''}]"

    rows = []
    for it in items:
        kind = it.get("type", "?")
        name = it.get("name", "?")
        size = it.get("size", 0)
        rows.append(f"{kind:5}  {name}{'' if kind == 'dir' else f'  ({size} bytes)'}")
    if not rows:
        return f"[empty directory: {repo}/{path or '(root)'}]"
    return "\n".join(rows)


# ── write_github_file ───────────────────────────────────────────────────────

async def _write_github_file(
    repo: str,
    path: str,
    content: str,
    commit_message: str,
    branch: str | None,
    token: str,
) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not path:
        raise ValueError("path is required.")
    if not token:
        raise ValueError("No GitHub token configured.")

    import base64

    headers = _gh_headers(token)
    url     = f"{GITHUB_API}/repos/{repo}/contents/{path.lstrip('/')}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        # GitHub's contents API requires the file's current SHA when overwriting.
        existing_sha: str | None = None
        get_params = {"ref": branch} if branch else None
        existing = await client.get(url, headers=headers, params=get_params)
        if existing.status_code == 200:
            existing_sha = existing.json().get("sha")

        body = {
            "message": commit_message,
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        }
        if existing_sha:
            body["sha"] = existing_sha
        if branch:
            body["branch"] = branch

        resp = await client.put(url, headers=headers, json=body)
        if resp.status_code >= 400:
            return f"[error: {resp.status_code} {resp.text[:300]}]"

        data    = resp.json()
        commit  = data.get("commit", {})
        sha     = commit.get("sha", "")
        ref     = branch or "default branch"
        size    = len(content.encode("utf-8"))
        action  = "updated" if existing_sha else "created"
        return f"{action} {repo}/{path} on {ref}  ({size} bytes, commit {sha[:7]})"


# ── delete_github_file ──────────────────────────────────────────────────────

async def _delete_github_file(
    repo: str,
    path: str,
    commit_message: str,
    branch: str | None,
    token: str,
) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not path:
        raise ValueError("path is required.")
    if not token:
        raise ValueError("No GitHub token configured.")

    headers = _gh_headers(token)
    url     = f"{GITHUB_API}/repos/{repo}/contents/{path.lstrip('/')}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        get_params = {"ref": branch} if branch else None
        existing = await client.get(url, headers=headers, params=get_params)
        if existing.status_code == 404:
            return f"[not found: {repo}/{path}]"
        existing.raise_for_status()
        sha = existing.json().get("sha")
        if not sha:
            return f"[error: could not resolve SHA for {repo}/{path}]"

        body = {"message": commit_message, "sha": sha}
        if branch:
            body["branch"] = branch

        resp = await client.request("DELETE", url, headers=headers, json=body)
        if resp.status_code >= 400:
            return f"[error: {resp.status_code} {resp.text[:300]}]"

        commit = resp.json().get("commit", {})
        return f"deleted {repo}/{path} on {branch or 'default branch'}  (commit {commit.get('sha', '')[:7]})"


# ── create_github_branch ────────────────────────────────────────────────────

async def _create_github_branch(repo: str, branch: str, from_ref: str | None, token: str) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not branch:
        raise ValueError("branch is required.")
    if not token:
        raise ValueError("No GitHub token configured.")

    headers = _gh_headers(token)

    async with httpx.AsyncClient(timeout=20.0) as client:
        # If no source ref given, look up the repo's default branch
        if not from_ref:
            r = await client.get(f"{GITHUB_API}/repos/{repo}", headers=headers)
            r.raise_for_status()
            from_ref = r.json().get("default_branch", "main")

        # Resolve the source ref to a SHA
        r = await client.get(f"{GITHUB_API}/repos/{repo}/git/refs/heads/{from_ref}", headers=headers)
        if r.status_code == 404:
            r = await client.get(f"{GITHUB_API}/repos/{repo}/commits/{from_ref}", headers=headers)
            r.raise_for_status()
            base_sha = r.json().get("sha")
        else:
            r.raise_for_status()
            base_sha = r.json().get("object", {}).get("sha")

        if not base_sha:
            return f"[error: could not resolve SHA for {from_ref}]"

        # Create the new ref
        resp = await client.post(
            f"{GITHUB_API}/repos/{repo}/git/refs",
            headers=headers,
            json={"ref": f"refs/heads/{branch}", "sha": base_sha},
        )
        if resp.status_code == 422:
            return f"[branch already exists: {branch}]"
        if resp.status_code >= 400:
            return f"[error: {resp.status_code} {resp.text[:300]}]"

    return f"created branch {branch} in {repo} from {from_ref} ({base_sha[:7]})"


# ── Helpers ─────────────────────────────────────────────────────────────────


def _gh_headers(token: str) -> dict:
    return {
        "Authorization":         f"Bearer {token}",
        "Accept":                "application/vnd.github+json",
        "X-GitHub-Api-Version":  "2022-11-28",
        "User-Agent":            USER_AGENT,
    }


_TEXTISH = ("text/", "json", "xml", "html", "javascript", "css", "yaml")


def _is_textish(content_type: str) -> bool:
    ct = content_type.lower()
    return any(t in ct for t in _TEXTISH)


_SCRIPT_OR_STYLE_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)
_TAG_RE             = re.compile(r"<[^>]+>")
_WHITESPACE_RE      = re.compile(r"\n{3,}")


def _strip_html_chrome(html: str) -> str:
    """Crude HTML-to-text: drop <script>/<style>, strip tags, collapse whitespace."""
    no_scripts = _SCRIPT_OR_STYLE_RE.sub("", html)
    no_tags    = _TAG_RE.sub(" ", no_scripts)
    cleaned    = _WHITESPACE_RE.sub("\n\n", no_tags)
    return cleaned.strip()
