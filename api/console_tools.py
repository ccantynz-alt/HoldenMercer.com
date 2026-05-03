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

async def _list_github_repos(search: str | None, token: str, org: str) -> str:
    if not token:
        raise ValueError("No GitHub token configured.")
    if not org:
        raise ValueError(
            "No GlueCron org configured. Add GLUECRON_GITHUB_ORG to the backend env."
        )

    headers = {
        "Authorization":         f"Bearer {token}",
        "Accept":                "application/vnd.github+json",
        "X-GitHub-Api-Version":  "2022-11-28",
        "User-Agent":            USER_AGENT,
    }
    # Try the user-repos endpoint first; if that 404s, try org-repos
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
        repos = resp.json()

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


# ── Helpers ─────────────────────────────────────────────────────────────────

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
