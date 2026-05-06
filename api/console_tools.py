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
    "search_repo_code": {
        "name": "search_repo_code",
        "description": (
            "Search the contents of files in a GitHub repository using GitHub's code "
            "search. Returns up to 25 matches with file paths and snippets. Use this "
            "to find where something is implemented when you don't know the exact path "
            "(e.g. 'where is auth handled?', 'where is the hero component?'). Lexical "
            "search — pick distinctive keywords."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":  { "type": "string", "description": "Repository in 'owner/name' form." },
                "query": { "type": "string", "description": "Keywords / identifier / string to search for." },
            },
            "required": ["repo", "query"],
        },
    },
    "search_past_sessions": {
        "name": "search_past_sessions",
        "description": (
            "Search through this project's saved session memories (under "
            ".holdenmercer/sessions/) for keyword matches. Use this when the user asks "
            "about previous work (\"what did we do last time?\", \"where did we leave "
            "off?\"). Recent sessions are auto-loaded into your context already; use "
            "this when you need to look further back."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":  { "type": "string", "description": "Repository in 'owner/name' form." },
                "query": { "type": "string", "description": "Keywords to match." },
                "limit": { "type": "integer", "description": "Max sessions to return. Default 5.", "default": 5 },
            },
            "required": ["repo", "query"],
        },
    },
    "search_my_repos": {
        "name": "search_my_repos",
        "description": (
            "Search file contents across ALL of the user's GitHub repos at once. "
            "Use this when the user asks about prior work that might live in a "
            "DIFFERENT project (\"how did I solve auth in another project?\", "
            "\"find every place I used Stripe\"). Lexical search — pick distinctive "
            "keywords. Returns up to 30 hits with file paths, repo names, and snippets."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Keywords / identifier to find." },
                "user":  {
                    "type": "string",
                    "description": "Optional GitHub user/org to scope to. Defaults to the configured GlueCron org.",
                },
            },
            "required": ["query"],
        },
    },
    "search_my_sessions": {
        "name": "search_my_sessions",
        "description": (
            "Search session memories across ALL of the user's projects, not just "
            "this one. Use this when the user is asking about past Claude work "
            "and you don't know which project they mean."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Keywords to match." },
                "limit": { "type": "integer", "description": "Max sessions to return. Default 5.", "default": 5 },
            },
            "required": ["query"],
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
            "Create or overwrite a SINGLE file in a GitHub repository, producing one "
            "commit. Use this for one-off edits. Prefer `commit_changes` when touching "
            "multiple files at once — it makes one atomic commit instead of N."
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
    "commit_changes": {
        "name": "commit_changes",
        "description": (
            "Make ONE atomic commit that touches multiple files (creates, updates, "
            "and/or deletes). Strongly preferred over multiple write_github_file "
            "calls when a logical change spans more than one file — produces a clean "
            "history (one commit per intent, not one commit per file). Uses the git "
            "Trees API under the hood."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo": { "type": "string", "description": "Repository in 'owner/name' form." },
                "commit_message": {
                    "type": "string",
                    "description": "Single commit message describing the whole change.",
                },
                "files": {
                    "type": "array",
                    "description": "List of file changes to apply atomically.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "File path within the repo." },
                            "action": {
                                "type": "string",
                                "enum": ["create", "update", "delete"],
                                "description": "What to do with the file.",
                            },
                            "content": {
                                "type": "string",
                                "description": "Full UTF-8 content (required for create / update; ignored for delete).",
                            },
                        },
                        "required": ["path", "action"],
                    },
                },
                "branch": {
                    "type": "string",
                    "description": "Optional target branch. Defaults to the repo's default branch.",
                },
            },
            "required": ["repo", "commit_message", "files"],
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
    "open_pull_request": {
        "name": "open_pull_request",
        "description": (
            "Open a pull request from a working branch back to the repo's default branch (or a "
            "specified base). Use this AFTER you've committed your work to a working branch — "
            "the PR is the merge proposal, not the merge itself. Returns the PR number + URL. "
            "Pair with merge_pull_request to actually ship; merging is gate-protected."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":  { "type": "string", "description": "Repository in 'owner/name' form." },
                "head":  { "type": "string", "description": "Working branch with the changes." },
                "base":  { "type": "string", "description": "Target branch to merge into. Defaults to the repo's default branch." },
                "title": { "type": "string", "description": "PR title — present-tense summary of the change." },
                "body":  { "type": "string", "description": "Optional PR description (markdown)." },
            },
            "required": ["repo", "head", "title"],
        },
    },
    "merge_pull_request": {
        "name": "merge_pull_request",
        "description": (
            "Merge a pull request into its base branch. REFUSES TO MERGE if the Holden Mercer "
            "gate hasn't completed successfully on the head SHA — this is the regression "
            "guarantee: nothing red lands on main. If the gate hasn't run yet, trigger it via "
            "run_gate first; if it failed, fix the failure on the same branch and re-run. "
            "Squash-merges by default (clean history)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":         { "type": "string", "description": "Repository in 'owner/name' form." },
                "pull_number":  { "type": "integer", "description": "PR number returned by open_pull_request." },
                "merge_method": {
                    "type": "string",
                    "enum": ["squash", "merge", "rebase"],
                    "description": "How to merge. Default: squash.",
                },
            },
            "required": ["repo", "pull_number"],
        },
    },
    "check_recent_activity": {
        "name": "check_recent_activity",
        "description": (
            "Get a snapshot of what's just happened in this repo: last 10 commits to the "
            "default branch, open pull requests (with their head branches), in-progress "
            "workflow runs, and the active-work manifest. Run this BEFORE making any "
            "changes so you don't branch from stale state and don't collide with another "
            "in-flight branch. The Console auto-loads this on session start, but call it "
            "again whenever the conversation has been running for a while."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo": { "type": "string", "description": "Repository in 'owner/name' form." },
            },
            "required": ["repo"],
        },
    },
    "claim_work": {
        "name": "claim_work",
        "description": (
            "Record that you're starting work on a branch by appending an entry to "
            "`.holdenmercer/active-work.json`. The entry lists the branch, your intent in one "
            "sentence, and the file paths you expect to touch. Other agent sessions that read "
            "the manifest will see your claim and avoid colliding. Call this RIGHT AFTER "
            "create_github_branch and BEFORE any commit on that branch."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":   { "type": "string", "description": "Repository in 'owner/name' form." },
                "branch": { "type": "string", "description": "The working branch you just created." },
                "intent": { "type": "string", "description": "One-sentence description of the goal." },
                "scope":  {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "List of file paths or directory globs you expect to touch.",
                },
                "agent":  {
                    "type": "string",
                    "description": "Identifier for who's doing the work, e.g. 'console' or 'task:<id>'.",
                },
            },
            "required": ["repo", "branch", "intent"],
        },
    },
    "release_work": {
        "name": "release_work",
        "description": (
            "Remove this branch's entry from `.holdenmercer/active-work.json`. Call this "
            "AFTER the branch has been merged via merge_pull_request, OR if you're abandoning "
            "the branch. Keeps the manifest clean for future sessions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":   { "type": "string", "description": "Repository in 'owner/name' form." },
                "branch": { "type": "string", "description": "The branch to release." },
            },
            "required": ["repo", "branch"],
        },
    },
}


# Tools that mutate state. Used by api/console.py to gate them behind
# autonomy modes (manual mode = read-only).
WRITE_TOOL_NAMES: set[str] = {
    "write_github_file",
    "commit_changes",
    "delete_github_file",
    "create_github_branch",
    "open_pull_request",
    "merge_pull_request",
    "claim_work",
    "release_work",
    "setup_gate_workflow",   # writes a workflow file
    "run_gate",              # mutates the actions queue
}

# Tools that delete or otherwise can't be reversed automatically. Smart-pause
# autonomy refuses these unless the user explicitly switches to full-auto.
# Manual mode strips them entirely (via WRITE_TOOL_NAMES).
DESTRUCTIVE_TOOL_NAMES: set[str] = {
    "delete_github_file",
}


def _all_tool_schemas() -> dict[str, dict]:
    """Combined view of read/write tools + gate tools, for backwards compat."""
    from api.gate_tools import GATE_TOOL_SCHEMAS
    return {**TOOL_SCHEMAS, **GATE_TOOL_SCHEMAS}


# ── Dispatcher ──────────────────────────────────────────────────────────────

async def run_tool(
    name: str,
    tool_input: dict,
    github_token: str,
    github_org: str,
    autonomy: str = "auto",
) -> str:
    """Run a tool by name. Returns plain text Claude can consume.

    Smart-pause guardrails: in autonomy='smart', destructive ops (delete_file)
    are refused with a clear message instead of executed. The agent gets the
    refusal as the tool result and can either rephrase, ask the user, or
    propose a safer alternative.
    """
    if autonomy == "smart" and name in DESTRUCTIVE_TOOL_NAMES:
        return (
            f"[SMART-PAUSE: refused to call {name} with input {tool_input!r} — "
            f"this is a destructive operation. Smart-pause autonomy blocks "
            f"destructive ops by default to keep the user's work safe. If the "
            f"user explicitly asked for this, suggest they switch autonomy to "
            f"'auto' in Settings, or propose a non-destructive alternative.]"
        )

    # Gate tools live in their own module to keep this file from sprawling.
    from api.gate_tools import GATE_TOOL_NAMES, run_gate_tool
    if name in GATE_TOOL_NAMES:
        return await run_gate_tool(name, tool_input, github_token)

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
    if name == "commit_changes":
        return await _commit_changes(
            repo=tool_input.get("repo", ""),
            files=tool_input.get("files") or [],
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
    if name == "open_pull_request":
        return await _open_pull_request(
            repo=tool_input.get("repo", ""),
            head=tool_input.get("head", ""),
            base=tool_input.get("base"),
            title=tool_input.get("title", ""),
            body=tool_input.get("body", ""),
            token=github_token,
        )
    if name == "merge_pull_request":
        return await _merge_pull_request(
            repo=tool_input.get("repo", ""),
            pull_number=int(tool_input.get("pull_number") or 0),
            merge_method=tool_input.get("merge_method") or "squash",
            token=github_token,
        )
    if name == "check_recent_activity":
        return await _check_recent_activity(tool_input.get("repo", ""), github_token)
    if name == "claim_work":
        return await _claim_work(
            repo=tool_input.get("repo", ""),
            branch=tool_input.get("branch", ""),
            intent=tool_input.get("intent", ""),
            scope=list(tool_input.get("scope") or []),
            agent=tool_input.get("agent") or "console",
            token=github_token,
        )
    if name == "release_work":
        return await _release_work(
            repo=tool_input.get("repo", ""),
            branch=tool_input.get("branch", ""),
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
    if name == "search_repo_code":
        return await _search_repo_code(
            repo=tool_input.get("repo", ""),
            query=tool_input.get("query", ""),
            token=github_token,
        )
    if name == "search_past_sessions":
        return await _search_past_sessions(
            repo=tool_input.get("repo", ""),
            query=tool_input.get("query", ""),
            limit=int(tool_input.get("limit", 5) or 5),
            token=github_token,
        )
    if name == "search_my_repos":
        return await _search_my_repos(
            query=tool_input.get("query", ""),
            user=tool_input.get("user") or github_org,
            token=github_token,
        )
    if name == "search_my_sessions":
        return await _search_my_sessions(
            query=tool_input.get("query", ""),
            limit=int(tool_input.get("limit", 5) or 5),
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
            "No code-host org/user configured. Open Settings → "
            "Code-host PAT and fill in the org / username field."
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


# ── commit_changes (multi-file atomic commit via git Trees API) ─────────────

async def _commit_changes(
    repo: str,
    files: list[dict],
    commit_message: str,
    branch: str | None,
    token: str,
) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not files:
        raise ValueError("files list is required.")
    if not token:
        raise ValueError("No GitHub token configured.")

    headers = _gh_headers(token)

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Resolve target branch
        target = branch
        if not target:
            r = await client.get(f"{GITHUB_API}/repos/{repo}", headers=headers)
            r.raise_for_status()
            target = r.json().get("default_branch", "main")

        # Get current ref → commit → tree
        ref = await client.get(
            f"{GITHUB_API}/repos/{repo}/git/refs/heads/{target}", headers=headers,
        )
        if ref.status_code == 404:
            return f"[branch not found: {target}]"
        ref.raise_for_status()
        head_sha = ref.json()["object"]["sha"]

        head_commit = await client.get(
            f"{GITHUB_API}/repos/{repo}/git/commits/{head_sha}", headers=headers,
        )
        head_commit.raise_for_status()
        base_tree_sha = head_commit.json()["tree"]["sha"]

        # Build tree entries — create a blob for each create / update,
        # null SHA for each delete.
        tree_entries: list[dict] = []
        creates_or_updates = 0
        deletes            = 0
        for f in files:
            path   = (f.get("path") or "").lstrip("/")
            action = (f.get("action") or "update").lower()
            if not path:
                return f"[error: file entry missing 'path']"

            if action == "delete":
                deletes += 1
                tree_entries.append({
                    "path": path, "mode": "100644", "type": "blob", "sha": None,
                })
                continue

            content = f.get("content") or ""
            blob = await client.post(
                f"{GITHUB_API}/repos/{repo}/git/blobs",
                headers=headers,
                json={"content": content, "encoding": "utf-8"},
            )
            if blob.status_code >= 400:
                return f"[error creating blob for {path}: {blob.status_code} {blob.text[:200]}]"
            tree_entries.append({
                "path": path, "mode": "100644", "type": "blob",
                "sha":  blob.json()["sha"],
            })
            creates_or_updates += 1

        # Create new tree on top of base
        new_tree = await client.post(
            f"{GITHUB_API}/repos/{repo}/git/trees",
            headers=headers,
            json={"base_tree": base_tree_sha, "tree": tree_entries},
        )
        if new_tree.status_code >= 400:
            return f"[error creating tree: {new_tree.status_code} {new_tree.text[:300]}]"
        new_tree_sha = new_tree.json()["sha"]

        # Create commit pointing at new tree
        new_commit = await client.post(
            f"{GITHUB_API}/repos/{repo}/git/commits",
            headers=headers,
            json={
                "message": commit_message,
                "tree":    new_tree_sha,
                "parents": [head_sha],
            },
        )
        if new_commit.status_code >= 400:
            return f"[error creating commit: {new_commit.status_code} {new_commit.text[:300]}]"
        new_sha = new_commit.json()["sha"]

        # Fast-forward the branch ref
        update = await client.patch(
            f"{GITHUB_API}/repos/{repo}/git/refs/heads/{target}",
            headers=headers,
            json={"sha": new_sha, "force": False},
        )
        if update.status_code >= 400:
            return (
                f"[error updating ref {target}: {update.status_code} {update.text[:300]}]\n"
                f"  (commit {new_sha[:7]} was created but ref couldn't be updated — "
                "likely a fast-forward conflict; try again)"
            )

    return (
        f"committed {creates_or_updates} write(s) + {deletes} delete(s) to "
        f"{repo}@{target} as {new_sha[:7]} — \"{commit_message}\""
    )


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


# ── search_repo_code ────────────────────────────────────────────────────────

async def _search_repo_code(repo: str, query: str, token: str) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not query.strip():
        raise ValueError("query is required.")
    if not token:
        raise ValueError("No GitHub token configured.")

    headers = _gh_headers(token)
    # GitHub code search requires text/match accept header for snippets.
    headers["Accept"] = "application/vnd.github.text-match+json"
    params = {"q": f"{query} repo:{repo}", "per_page": 25}

    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(
            f"{GITHUB_API}/search/code",
            headers=headers,
            params=params,
        )
        if resp.status_code == 422:
            return "[search rejected: needs at least one keyword + a repo qualifier]"
        if resp.status_code >= 400:
            return f"[error: {resp.status_code} {resp.text[:200]}]"
        data = resp.json()

    items = data.get("items", [])
    if not items:
        return f"[no matches for {query!r} in {repo}]"

    rows: list[str] = [f"{data.get('total_count', 0)} match(es) for {query!r} in {repo} (showing {len(items)}):", ""]
    for it in items:
        path = it.get("path", "")
        url  = it.get("html_url", "")
        rows.append(f"• {path}")
        rows.append(f"  {url}")
        for tm in (it.get("text_matches") or [])[:2]:
            fragment = (tm.get("fragment") or "").strip()
            if fragment:
                # Indent for readability and trim absurd lines
                short = "\n    ".join(fragment.splitlines()[:6])
                rows.append(f"    {short}")
        rows.append("")
    return "\n".join(rows).rstrip()


# ── search_past_sessions ────────────────────────────────────────────────────

async def _search_past_sessions(repo: str, query: str, limit: int, token: str) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not query.strip():
        raise ValueError("query is required.")
    if not token:
        raise ValueError("No GitHub token configured.")

    headers = _gh_headers(token)
    listing_url = f"{GITHUB_API}/repos/{repo}/contents/.holdenmercer/sessions"

    async with httpx.AsyncClient(timeout=30.0) as client:
        listing_resp = await client.get(listing_url, headers=headers)
        if listing_resp.status_code == 404:
            return "[no session history yet — chat with Claude to start writing memories]"
        listing_resp.raise_for_status()
        files = [
            f for f in listing_resp.json()
            if f.get("type") == "file" and (f.get("name") or "").endswith(".md")
        ]
        # Sort newest first by filename (timestamp-prefixed: YYYY-MM-DD-HHMMSS.md)
        files.sort(key=lambda f: f.get("name", ""), reverse=True)

        # Fetch each file's content, score by query keyword frequency
        needle = query.lower()
        scored: list[tuple[int, dict, str]] = []
        for f in files[:60]:                    # cap how far back we look
            file_resp = await client.get(
                f["url"], headers={**headers, "Accept": "application/vnd.github.raw"},
            )
            if file_resp.status_code != 200:
                continue
            text = file_resp.text
            score = text.lower().count(needle)
            if score:
                scored.append((score, f, text))

    if not scored:
        return f"[no past sessions match {query!r}]"

    scored.sort(key=lambda t: (-t[0], t[1].get("name", "")), reverse=False)
    out: list[str] = [f"{len(scored)} matching session(s) for {query!r}:", ""]
    for score, f, text in scored[:limit]:
        out.append(f"### {f.get('name')}  ({score} hit{'s' if score != 1 else ''})")
        # Pull the snippet around the first match
        idx = text.lower().find(needle)
        if idx >= 0:
            start = max(0, idx - 200)
            end   = min(len(text), idx + 400)
            snippet = text[start:end].strip()
            out.append(snippet)
        out.append("")
    return "\n".join(out).rstrip()


# ── search_my_repos (lexical, across ALL of the user's repos) ───────────────

async def _search_my_repos(query: str, user: str, token: str) -> str:
    if not query.strip():
        raise ValueError("query is required.")
    if not token:
        raise ValueError("No GitHub token configured.")
    if not user:
        raise ValueError("No GitHub user/org configured.")

    headers = {**_gh_headers(token), "Accept": "application/vnd.github.text-match+json"}
    # GitHub code search supports a `user:` qualifier to scope across all
    # repos owned by a user (or `org:` for an org). Try user first; if zero
    # results, retry with org:.
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(
            f"{GITHUB_API}/search/code",
            headers=headers,
            params={"q": f"{query} user:{user}", "per_page": 30},
        )
        if resp.status_code == 422:
            return "[search rejected: needs at least one keyword]"
        if resp.status_code >= 400:
            return f"[error: {resp.status_code} {resp.text[:200]}]"
        data = resp.json()
        items = data.get("items", [])
        if not items:
            # try as org
            resp2 = await client.get(
                f"{GITHUB_API}/search/code",
                headers=headers,
                params={"q": f"{query} org:{user}", "per_page": 30},
            )
            if resp2.status_code < 400:
                data  = resp2.json()
                items = data.get("items", [])

    if not items:
        return f"[no matches for {query!r} across {user}'s repos]"

    rows: list[str] = [
        f"{data.get('total_count', 0)} match(es) for {query!r} across {user}'s repos "
        f"(showing {len(items)}):", "",
    ]
    for it in items:
        repo_name = (it.get("repository") or {}).get("full_name", "?")
        path      = it.get("path", "")
        url       = it.get("html_url", "")
        rows.append(f"• {repo_name}/{path}")
        rows.append(f"  {url}")
        for tm in (it.get("text_matches") or [])[:2]:
            fragment = (tm.get("fragment") or "").strip()
            if fragment:
                short = "\n    ".join(fragment.splitlines()[:6])
                rows.append(f"    {short}")
        rows.append("")
    return "\n".join(rows).rstrip()


# ── search_my_sessions (across ALL projects' .holdenmercer/sessions/) ───────

async def _search_my_sessions(query: str, limit: int, token: str, org: str) -> str:
    if not query.strip():
        raise ValueError("query is required.")
    if not token:
        raise ValueError("No GitHub token configured.")
    if not org:
        raise ValueError("No GitHub user/org configured.")

    # Use code search with a path filter — finds matching session files across
    # any repo we have access to under the user/org.
    headers = {**_gh_headers(token), "Accept": "application/vnd.github.text-match+json"}
    qparts = [query, f"user:{org}", "path:.holdenmercer/sessions"]
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(
            f"{GITHUB_API}/search/code",
            headers=headers,
            params={"q": " ".join(qparts), "per_page": min(limit, 25)},
        )
        if resp.status_code == 422:
            return "[search rejected: needs at least one keyword]"
        if resp.status_code >= 400:
            return f"[error: {resp.status_code} {resp.text[:200]}]"
        data  = resp.json()
        items = data.get("items", [])

    if not items:
        return f"[no past sessions match {query!r} across your projects]"

    rows: list[str] = [
        f"{len(items)} matching session(s) for {query!r}:", "",
    ]
    for it in items[:limit]:
        repo_name = (it.get("repository") or {}).get("full_name", "?")
        name      = it.get("name", "")
        url       = it.get("html_url", "")
        rows.append(f"### {repo_name} — {name}")
        rows.append(f"  {url}")
        for tm in (it.get("text_matches") or [])[:1]:
            fragment = (tm.get("fragment") or "").strip()
            if fragment:
                rows.append("")
                rows.append(fragment[:600])
        rows.append("")
    return "\n".join(rows).rstrip()


# ── open_pull_request / merge_pull_request ──────────────────────────────────

async def _open_pull_request(
    repo: str,
    head: str,
    base: str | None,
    title: str,
    body: str,
    token: str,
) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not head:
        raise ValueError("head branch is required.")
    if not title:
        raise ValueError("title is required.")
    if not token:
        raise ValueError("No GitHub token configured.")

    headers = _gh_headers(token)
    async with httpx.AsyncClient(timeout=30.0) as client:
        target = base
        if not target:
            r = await client.get(f"{GITHUB_API}/repos/{repo}", headers=headers)
            r.raise_for_status()
            target = r.json().get("default_branch", "main")

        resp = await client.post(
            f"{GITHUB_API}/repos/{repo}/pulls",
            headers=headers,
            json={"head": head, "base": target, "title": title, "body": body or ""},
        )
        if resp.status_code == 422:
            # Common: "No commits between base and head" or PR already exists
            return f"[error: {resp.status_code} {resp.text[:300]}]"
        if resp.status_code >= 400:
            return f"[error: {resp.status_code} {resp.text[:300]}]"
        data = resp.json()

    return (
        f"opened PR #{data.get('number')} in {repo} "
        f"({head} → {target}) — {title}\n  {data.get('html_url')}"
    )


async def _merge_pull_request(
    repo: str,
    pull_number: int,
    merge_method: str,
    token: str,
) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not pull_number:
        raise ValueError("pull_number is required.")
    if not token:
        raise ValueError("No GitHub token configured.")
    if merge_method not in ("squash", "merge", "rebase"):
        merge_method = "squash"

    headers = _gh_headers(token)
    async with httpx.AsyncClient(timeout=30.0) as client:
        # Fetch the PR to get head SHA + branches
        pr = await client.get(f"{GITHUB_API}/repos/{repo}/pulls/{pull_number}", headers=headers)
        if pr.status_code == 404:
            return f"[PR #{pull_number} not found in {repo}]"
        pr.raise_for_status()
        pr_data    = pr.json()
        head_sha   = pr_data.get("head", {}).get("sha", "")
        head_ref   = pr_data.get("head", {}).get("ref", "")
        base_ref   = pr_data.get("base", {}).get("ref", "")
        if pr_data.get("merged"):
            return f"[PR #{pull_number} is already merged]"
        if pr_data.get("state") == "closed":
            return f"[PR #{pull_number} is closed (not merged)]"

        # Refuse to merge if the gate hasn't completed successfully on the head SHA.
        # Look up the most recent gate workflow run for this head_sha.
        runs = await client.get(
            f"{GITHUB_API}/repos/{repo}/actions/workflows/holden-mercer-gate.yml/runs",
            headers=headers,
            params={"head_sha": head_sha, "per_page": 1},
        )
        if runs.status_code == 404:
            return (
                "[REFUSED: gate workflow not installed in this repo. "
                "Install it via setup_gate_workflow, then run_gate on this branch, "
                "then re-attempt merge_pull_request.]"
            )
        runs.raise_for_status()
        items = runs.json().get("workflow_runs", [])
        if not items:
            return (
                f"[REFUSED: no gate run found for head SHA {head_sha[:7]}. "
                f"Trigger run_gate(repo={repo!r}, branch={head_ref!r}) first, "
                f"wait for it to finish, then re-attempt merge_pull_request.]"
            )
        latest = items[0]
        if latest.get("status") != "completed":
            return (
                f"[REFUSED: gate run {latest.get('id')} is still {latest.get('status')!r}. "
                f"Wait via check_gate(repo, run_id={latest.get('id')}) until it completes.]"
            )
        if latest.get("conclusion") != "success":
            return (
                f"[REFUSED: gate run {latest.get('id')} concluded "
                f"{latest.get('conclusion')!r} — main never receives a red commit. "
                f"Read the failure via read_gate_logs(repo, run_id={latest.get('id')}), "
                f"fix the failure on this branch, run_gate again, then re-attempt.]"
            )

        # All-clear — perform the merge
        merge = await client.put(
            f"{GITHUB_API}/repos/{repo}/pulls/{pull_number}/merge",
            headers=headers,
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


# ── check_recent_activity (pre-flight briefing for agents) ──────────────────

async def _check_recent_activity(repo: str, token: str) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not token:
        raise ValueError("No GitHub token configured.")

    headers = _gh_headers(token)
    async with httpx.AsyncClient(timeout=20.0) as client:
        # Resolve default branch
        repo_info = await client.get(f"{GITHUB_API}/repos/{repo}", headers=headers)
        repo_info.raise_for_status()
        default_branch = repo_info.json().get("default_branch", "main")

        commits, prs, runs = await asyncio.gather(
            client.get(
                f"{GITHUB_API}/repos/{repo}/commits",
                headers=headers,
                params={"sha": default_branch, "per_page": 10},
            ),
            client.get(
                f"{GITHUB_API}/repos/{repo}/pulls",
                headers=headers,
                params={"state": "open", "per_page": 10, "sort": "updated", "direction": "desc"},
            ),
            client.get(
                f"{GITHUB_API}/repos/{repo}/actions/runs",
                headers=headers,
                params={"status": "in_progress", "per_page": 10},
            ),
        )

    out: list[str] = []
    out.append(f"Pre-flight briefing for {repo} (default branch: {default_branch})\n")

    if commits.status_code < 400:
        items = commits.json() or []
        out.append(f"## Last {len(items)} commits on {default_branch}")
        for c in items:
            sha    = (c.get("sha") or "")[:7]
            msg    = (c.get("commit", {}).get("message") or "").split("\n", 1)[0]
            author = c.get("commit", {}).get("author", {}).get("name") or (c.get("author") or {}).get("login") or "?"
            date   = c.get("commit", {}).get("author", {}).get("date") or ""
            out.append(f"  {sha}  {date}  {author}: {msg}")
        out.append("")

    if prs.status_code < 400:
        items = prs.json() or []
        out.append(f"## Open PRs ({len(items)})")
        if not items:
            out.append("  (none)")
        for p in items:
            out.append(
                f"  #{p.get('number')}  {p.get('head', {}).get('ref')} → {p.get('base', {}).get('ref')}  "
                f"by {(p.get('user') or {}).get('login', '?')}: {p.get('title')}"
            )
        out.append("")

    if runs.status_code < 400:
        items = runs.json().get("workflow_runs", []) or []
        out.append(f"## In-progress workflow runs ({len(items)})")
        if not items:
            out.append("  (none)")
        for r in items:
            out.append(
                f"  run {r.get('id')}  {r.get('name')}  on {r.get('head_branch')}  "
                f"({r.get('status')})  → {r.get('html_url')}"
            )
        out.append("")

    # Active-work manifest
    manifest = await _read_active_work(repo, default_branch, token)
    out.append(f"## Active-work manifest ({len(manifest.get('active', []))} entries)")
    if not manifest.get("active"):
        out.append("  (no in-flight branches claimed)")
    else:
        for c in manifest["active"]:
            paths = ", ".join((c.get("scope") or [])[:6]) or "(no scope listed)"
            out.append(
                f"  {c.get('branch')}  {c.get('startedAt')}  agent={c.get('agent', '?')}\n"
                f"    intent: {c.get('intent', '')}\n"
                f"    scope:  {paths}"
            )
    out.append("")
    out.append(
        "Read this BEFORE editing. If your planned files overlap with an open PR's "
        "branch or another agent's claimed scope, branch from THAT branch instead "
        "of the default — or coordinate by handing off to that PR. Never branch "
        "from a stale state."
    )
    return "\n".join(out)


# ── claim_work / release_work (active-work manifest) ────────────────────────

ACTIVE_WORK_PATH = ".holdenmercer/active-work.json"


async def _read_active_work(repo: str, branch: str | None, token: str) -> dict:
    headers = {**_gh_headers(token), "Accept": "application/vnd.github.raw"}
    params = {"ref": branch} if branch else None
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(
            f"{GITHUB_API}/repos/{repo}/contents/{ACTIVE_WORK_PATH}",
            headers=headers, params=params,
        )
    if r.status_code != 200:
        return {"version": 1, "active": []}
    try:
        data = r.json() if r.headers.get("content-type", "").startswith("application/json") \
               else __import__("json").loads(r.text)
    except Exception:
        return {"version": 1, "active": []}
    if not isinstance(data, dict):
        return {"version": 1, "active": []}
    if not isinstance(data.get("active"), list):
        data["active"] = []
    data.setdefault("version", 1)
    return data


async def _claim_work(
    repo: str, branch: str, intent: str, scope: list[str], agent: str, token: str,
) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not branch:
        raise ValueError("branch is required.")
    if not token:
        raise ValueError("No GitHub token configured.")

    import datetime as _dt
    import json as _json

    # We always read + write against the repo's default branch so the
    # manifest stays canonical and isn't fork-bombed across feature branches.
    headers = _gh_headers(token)
    async with httpx.AsyncClient(timeout=30.0) as client:
        repo_info = await client.get(f"{GITHUB_API}/repos/{repo}", headers=headers)
        repo_info.raise_for_status()
        default_branch = repo_info.json().get("default_branch", "main")

    manifest = await _read_active_work(repo, default_branch, token)
    # De-dupe: replace any existing entry for this branch
    manifest["active"] = [c for c in manifest["active"] if c.get("branch") != branch]
    manifest["active"].insert(0, {
        "branch":    branch,
        "agent":     agent or "console",
        "scope":     scope,
        "startedAt": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "intent":    intent[:240],
    })
    body = _json.dumps(manifest, indent=2) + "\n"
    return await _write_meta_file(
        repo=repo,
        path=ACTIVE_WORK_PATH,
        content=body,
        commit_message=f"chore(active-work): claim {branch}",
        branch=default_branch,
        token=token,
    )


async def _release_work(repo: str, branch: str, token: str) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not branch:
        raise ValueError("branch is required.")
    if not token:
        raise ValueError("No GitHub token configured.")

    import json as _json

    headers = _gh_headers(token)
    async with httpx.AsyncClient(timeout=30.0) as client:
        repo_info = await client.get(f"{GITHUB_API}/repos/{repo}", headers=headers)
        repo_info.raise_for_status()
        default_branch = repo_info.json().get("default_branch", "main")

    manifest = await _read_active_work(repo, default_branch, token)
    before = len(manifest["active"])
    manifest["active"] = [c for c in manifest["active"] if c.get("branch") != branch]
    if len(manifest["active"]) == before:
        return f"[no claim found for branch {branch} — nothing to release]"
    body = _json.dumps(manifest, indent=2) + "\n"
    return await _write_meta_file(
        repo=repo,
        path=ACTIVE_WORK_PATH,
        content=body,
        commit_message=f"chore(active-work): release {branch}",
        branch=default_branch,
        token=token,
    )


async def _write_meta_file(
    repo: str, path: str, content: str, commit_message: str,
    branch: str | None, token: str,
) -> str:
    """Internal helper — same as _write_github_file but without the autonomy
    plumbing (this is for housekeeping commits like active-work updates)."""
    return await _write_github_file(
        repo=repo, path=path, content=content,
        commit_message=commit_message, branch=branch, token=token,
    )


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
