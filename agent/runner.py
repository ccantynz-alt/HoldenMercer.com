"""
Holden Mercer — background agent runner.

This script runs INSIDE GitHub Actions (the holden-mercer-task.yml workflow)
to execute long-running Claude tasks. The dashboard dispatches the workflow
with a prompt; the workflow runs this script; the script:

    1. Calls Anthropic with a tool-use loop (read/write files, run gate, web fetch).
    2. Writes a summary of what it did to .holdenmercer/tasks/<task_id>.md.
    3. Commits both the work AND the summary.

The dashboard polls the workflow run for status and reads the summary file.

This is intentionally self-contained — no imports from the Holden Mercer
backend. The workflow setup tool drops it at .holdenmercer/agent_runner.py
in your repo. You can edit it freely; re-running setup_task_workflow
overwrites it.

Required env (set by the workflow):
    HM_REPO            owner/repo
    HM_TASK_ID         opaque task id from the dashboard
    HM_PROMPT          user-supplied task prompt
    HM_BRIEF           project brief (system context)
    HM_MODEL           claude-opus-4-7 / etc
    HM_MAX_ITERS       safety cap on tool-use turns (default 30)
    ANTHROPIC_API_KEY  user's BYOK key, stored as a repo secret
    GITHUB_TOKEN       provided by GitHub Actions
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import os
import re
import sys
import time
from typing import Any

import anthropic
import httpx


# ── Config from environment ─────────────────────────────────────────────────

REPO          = os.environ["HM_REPO"]
TASK_ID       = os.environ["HM_TASK_ID"]
PROMPT        = os.environ["HM_PROMPT"]
BRIEF         = os.environ.get("HM_BRIEF", "")
MODEL         = os.environ.get("HM_MODEL", "claude-opus-4-7")
MAX_ITERS     = int(os.environ.get("HM_MAX_ITERS", "30"))
BRANCH        = os.environ.get("HM_BRANCH") or None
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]
GH_TOKEN      = os.environ["GITHUB_TOKEN"]

GH_API     = "https://api.github.com"
USER_AGENT = "Holden Mercer Background Agent"

GH_HEADERS = {
    "Authorization":         f"Bearer {GH_TOKEN}",
    "Accept":                "application/vnd.github+json",
    "X-GitHub-Api-Version":  "2022-11-28",
    "User-Agent":            USER_AGENT,
}


# ── Tools the agent can use ─────────────────────────────────────────────────

TOOLS: list[dict] = [
    {
        "name": "read_file",
        "description": "Read a file from this repository.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path within the repo."},
                "ref":  {"type": "string", "description": "Optional branch / SHA. Default: repo default branch."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_dir",
        "description": "List the contents of a directory in this repository.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path. Empty = repo root."},
                "ref":  {"type": "string"},
            },
        },
    },
    {
        "name": "write_file",
        "description": (
            "Create or overwrite a SINGLE file (one commit). Prefer commit_changes "
            "for multi-file edits."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path":           {"type": "string"},
                "content":        {"type": "string"},
                "commit_message": {"type": "string"},
                "branch":         {"type": "string"},
            },
            "required": ["path", "content", "commit_message"],
        },
    },
    {
        "name": "commit_changes",
        "description": (
            "Make ONE atomic commit touching multiple files. Strongly preferred over "
            "calling write_file many times when a logical change spans multiple files."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "commit_message": {"type": "string"},
                "files": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path":    {"type": "string"},
                            "action":  {"type": "string", "enum": ["create", "update", "delete"]},
                            "content": {"type": "string"},
                        },
                        "required": ["path", "action"],
                    },
                },
                "branch": {"type": "string"},
            },
            "required": ["commit_message", "files"],
        },
    },
    {
        "name": "delete_file",
        "description": "Delete a file from this repository (real commit). Use sparingly.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path":           {"type": "string"},
                "commit_message": {"type": "string"},
                "branch":         {"type": "string"},
            },
            "required": ["path", "commit_message"],
        },
    },
    {
        "name": "web_fetch",
        "description": "Fetch any public web page or HTML / text URL.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "trigger_gate",
        "description": (
            "Trigger the Holden Mercer gate workflow. Returns immediately with the "
            "run URL — does not wait for completion."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "branch": {"type": "string"},
            },
        },
    },
    {
        "name": "report_result",
        "description": (
            "Call this once when you are done. Pass a one-paragraph summary of what "
            "you accomplished. The agent loop will exit after this is called."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "summary":  {"type": "string"},
                "success":  {"type": "boolean"},
            },
            "required": ["summary", "success"],
        },
    },
]


# ── Tool implementations ────────────────────────────────────────────────────

class Done(Exception):
    """Raised when the agent calls report_result."""

    def __init__(self, summary: str, success: bool) -> None:
        self.summary = summary
        self.success = success


def _gh(method: str, path: str, **kwargs) -> httpx.Response:
    url = f"{GH_API}/repos/{REPO}{path}"
    return httpx.request(method, url, headers=GH_HEADERS, timeout=30.0, **kwargs)


def tool_read_file(path: str, ref: str | None = None) -> str:
    headers = {**GH_HEADERS, "Accept": "application/vnd.github.raw"}
    params  = {"ref": ref} if ref else None
    resp    = httpx.get(
        f"{GH_API}/repos/{REPO}/contents/{path.lstrip('/')}",
        headers=headers, params=params, timeout=30.0,
    )
    if resp.status_code == 404:
        return f"[not found: {path}]"
    resp.raise_for_status()
    if len(resp.content) > 200_000:
        return f"[refused: {len(resp.content)} bytes, over 200 KB cap]"
    try:
        return resp.text
    except UnicodeDecodeError:
        return "[refused: binary file]"


def tool_list_dir(path: str = "", ref: str | None = None) -> str:
    params = {"ref": ref} if ref else None
    resp   = _gh("GET", f"/contents/{path.lstrip('/')}", params=params)
    if resp.status_code == 404:
        return f"[not found: {path or '(root)'}]"
    resp.raise_for_status()
    items = resp.json()
    if isinstance(items, dict):
        return f"{items.get('type', 'file')}  {items.get('path')}"
    rows = [
        f"{it.get('type'):5}  {it.get('name')}{'' if it.get('type') == 'dir' else f'  ({it.get(\"size\", 0)} bytes)'}"
        for it in items
    ]
    return "\n".join(rows) or "[empty]"


def tool_write_file(path: str, content: str, commit_message: str, branch: str | None = None) -> str:
    branch = branch or BRANCH
    # Resolve existing SHA so we can overwrite cleanly
    params = {"ref": branch} if branch else None
    head = _gh("GET", f"/contents/{path.lstrip('/')}", params=params)
    sha = head.json().get("sha") if head.status_code == 200 else None

    body: dict[str, Any] = {
        "message": commit_message,
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
    }
    if sha:    body["sha"]    = sha
    if branch: body["branch"] = branch

    resp = _gh("PUT", f"/contents/{path.lstrip('/')}", json=body)
    if resp.status_code >= 400:
        return f"[error: {resp.status_code} {resp.text[:300]}]"
    sha = resp.json().get("commit", {}).get("sha", "")
    action = "updated" if head.status_code == 200 else "created"
    return f"{action} {path} ({len(content)} bytes, commit {sha[:7]})"


def tool_commit_changes(commit_message: str, files: list[dict], branch: str | None = None) -> str:
    branch = branch or BRANCH
    if not files:
        return "[no files supplied]"

    # Resolve target branch
    target = branch
    if not target:
        r = httpx.get(f"{GH_API}/repos/{REPO}", headers=GH_HEADERS, timeout=20.0)
        r.raise_for_status()
        target = r.json().get("default_branch", "main")

    # Get head ref + base tree
    ref = httpx.get(f"{GH_API}/repos/{REPO}/git/refs/heads/{target}", headers=GH_HEADERS, timeout=20.0)
    if ref.status_code == 404:
        return f"[branch not found: {target}]"
    ref.raise_for_status()
    head_sha = ref.json()["object"]["sha"]
    head_commit = httpx.get(f"{GH_API}/repos/{REPO}/git/commits/{head_sha}", headers=GH_HEADERS, timeout=20.0)
    head_commit.raise_for_status()
    base_tree = head_commit.json()["tree"]["sha"]

    # Build tree entries
    tree_entries: list[dict] = []
    writes = deletes = 0
    for f in files:
        path   = (f.get("path") or "").lstrip("/")
        action = (f.get("action") or "update").lower()
        if not path:
            return "[error: file entry missing 'path']"
        if action == "delete":
            deletes += 1
            tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            continue
        content = f.get("content") or ""
        blob = httpx.post(
            f"{GH_API}/repos/{REPO}/git/blobs",
            headers=GH_HEADERS, timeout=30.0,
            json={"content": content, "encoding": "utf-8"},
        )
        if blob.status_code >= 400:
            return f"[blob error for {path}: {blob.status_code}]"
        tree_entries.append({
            "path": path, "mode": "100644", "type": "blob", "sha": blob.json()["sha"],
        })
        writes += 1

    new_tree = httpx.post(
        f"{GH_API}/repos/{REPO}/git/trees",
        headers=GH_HEADERS, timeout=30.0,
        json={"base_tree": base_tree, "tree": tree_entries},
    )
    if new_tree.status_code >= 400:
        return f"[tree error: {new_tree.status_code} {new_tree.text[:200]}]"

    commit = httpx.post(
        f"{GH_API}/repos/{REPO}/git/commits",
        headers=GH_HEADERS, timeout=30.0,
        json={"message": commit_message, "tree": new_tree.json()["sha"], "parents": [head_sha]},
    )
    if commit.status_code >= 400:
        return f"[commit error: {commit.status_code} {commit.text[:200]}]"
    new_sha = commit.json()["sha"]

    update = httpx.patch(
        f"{GH_API}/repos/{REPO}/git/refs/heads/{target}",
        headers=GH_HEADERS, timeout=20.0,
        json={"sha": new_sha, "force": False},
    )
    if update.status_code >= 400:
        return f"[ref update error: {update.status_code} {update.text[:200]}]"
    return f"committed {writes} write(s) + {deletes} delete(s) to {target} as {new_sha[:7]} — \"{commit_message}\""


def tool_delete_file(path: str, commit_message: str, branch: str | None = None) -> str:
    branch = branch or BRANCH
    params = {"ref": branch} if branch else None
    head = _gh("GET", f"/contents/{path.lstrip('/')}", params=params)
    if head.status_code == 404:
        return f"[not found: {path}]"
    head.raise_for_status()
    sha = head.json().get("sha")
    body: dict[str, Any] = {"message": commit_message, "sha": sha}
    if branch: body["branch"] = branch
    resp = _gh("DELETE", f"/contents/{path.lstrip('/')}", json=body)
    if resp.status_code >= 400:
        return f"[error: {resp.status_code} {resp.text[:300]}]"
    return f"deleted {path}"


def tool_web_fetch(url: str) -> str:
    if not url or not re.match(r"^https?://", url):
        return "[refused: URL must be absolute http(s)]"
    with httpx.Client(follow_redirects=True, timeout=20.0, headers={"User-Agent": USER_AGENT}) as c:
        resp = c.get(url)
    if resp.status_code >= 400:
        return f"[error: {resp.status_code}]"
    ct = resp.headers.get("content-type", "").lower()
    if not any(t in ct for t in ("text/", "json", "xml", "html", "javascript", "css", "yaml")):
        return f"[refused: content-type {ct!r}]"
    body = resp.text
    if "html" in ct:
        body = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", body, flags=re.S | re.I)
        body = re.sub(r"<[^>]+>", " ", body)
    if len(body) > 200_000:
        body = body[:200_000] + "\n…[truncated]"
    return body.strip()


def tool_trigger_gate(branch: str | None = None) -> str:
    branch = branch or BRANCH or "main"
    resp = _gh(
        "POST",
        "/actions/workflows/holden-mercer-gate.yml/dispatches",
        json={"ref": branch},
    )
    if resp.status_code == 404:
        return "[gate workflow not installed in this repo]"
    if resp.status_code >= 400:
        return f"[error: {resp.status_code} {resp.text[:200]}]"
    return f"gate triggered on {branch} — view at https://github.com/{REPO}/actions/workflows/holden-mercer-gate.yml"


def tool_report_result(summary: str, success: bool) -> str:
    raise Done(summary=summary, success=success)


def run_tool(name: str, inp: dict) -> str:
    try:
        if name == "read_file":      return tool_read_file(inp.get("path", ""), inp.get("ref"))
        if name == "list_dir":       return tool_list_dir(inp.get("path", ""), inp.get("ref"))
        if name == "write_file":     return tool_write_file(inp["path"], inp["content"], inp["commit_message"], inp.get("branch"))
        if name == "commit_changes": return tool_commit_changes(inp["commit_message"], inp.get("files") or [], inp.get("branch"))
        if name == "delete_file":    return tool_delete_file(inp["path"], inp["commit_message"], inp.get("branch"))
        if name == "web_fetch":      return tool_web_fetch(inp.get("url", ""))
        if name == "trigger_gate":   return tool_trigger_gate(inp.get("branch"))
        if name == "report_result":  return tool_report_result(inp["summary"], bool(inp.get("success", True)))
        return f"[unknown tool: {name}]"
    except Done:
        raise
    except Exception as exc:
        return f"[tool error: {type(exc).__name__}: {exc}]"


# ── System prompt + agent loop ──────────────────────────────────────────────

SYSTEM_PROMPT = f"""You are a background build agent for project repo {REPO}.
You run autonomously inside GitHub Actions — there is no user to ask follow-up
questions. Make decisions, commit changes, then call `report_result` exactly
once when finished.

{('Project brief:' + chr(10) + BRIEF) if BRIEF.strip() else 'No project brief was provided.'}

Tools:
  - read_file(path), list_dir(path) — explore the repo
  - write_file(path, content, commit_message) — single-file commit
  - commit_changes(commit_message, files=[{path, action, content}]) — ATOMIC multi-file
    commit (preferred over multiple write_file calls when a logical change touches
    several files; one commit per intent, not one per file)
  - delete_file(path, commit_message) — remove files (sparingly)
  - web_fetch(url) — pull external context
  - trigger_gate() — fire the lint/typecheck/tests workflow after substantial changes
  - report_result(summary, success) — REQUIRED: call this when done with a one-paragraph
    summary of what you accomplished + a success boolean

Conventions:
  - Always read a file before overwriting it.
  - Make many small commits with descriptive messages, not one giant one.
  - When you finish a feature, trigger the gate and (briefly) note the run URL in your summary.
  - Be decisive. You will not get another chance to ask the user.
"""


def run() -> dict:
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY, timeout=120.0)
    messages: list[dict] = [{"role": "user", "content": PROMPT}]
    transcript: list[str] = []
    started = time.time()
    summary  = ""
    success  = False

    for i in range(MAX_ITERS):
        resp = client.messages.create(
            model=MODEL,
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )

        assistant_blocks: list[dict] = []
        tool_uses: list[dict] = []
        for block in resp.content:
            if block.type == "text":
                if block.text.strip():
                    transcript.append(block.text.strip())
                assistant_blocks.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                assistant_blocks.append({
                    "type": "tool_use", "id": block.id, "name": block.name, "input": block.input,
                })
                tool_uses.append({"id": block.id, "name": block.name, "input": block.input})

        messages.append({"role": "assistant", "content": assistant_blocks})

        if resp.stop_reason != "tool_use" or not tool_uses:
            # Model stopped without calling report_result; treat as success-ish if it produced text
            summary = (transcript[-1] if transcript else "Agent finished without calling report_result.")
            break

        tool_results = []
        for tu in tool_uses:
            print(f"::group::tool {tu['name']}")
            print(json.dumps(tu["input"])[:1000])
            try:
                output = run_tool(tu["name"], tu["input"])
            except Done as done:
                summary = done.summary
                success = done.success
                tool_results.append({
                    "type": "tool_result", "tool_use_id": tu["id"],
                    "content": "Acknowledged. Exiting agent loop.",
                })
                messages.append({"role": "user", "content": tool_results})
                print("::endgroup::")
                return {"summary": summary, "success": success, "iters": i + 1, "duration_s": int(time.time() - started)}
            except Exception as exc:
                output = f"[tool crashed: {type(exc).__name__}: {exc}]"
            print(output[:1000])
            print("::endgroup::")
            tool_results.append({
                "type": "tool_result", "tool_use_id": tu["id"], "content": output,
            })
        messages.append({"role": "user", "content": tool_results})

    return {
        "summary":  summary or "Hit max iterations without report_result.",
        "success":  success,
        "iters":    MAX_ITERS,
        "duration_s": int(time.time() - started),
    }


def write_result(payload: dict) -> None:
    """Commit the result file so the dashboard can pick it up."""
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    body = (
        f"# Task `{TASK_ID}`\n\n"
        f"- **Status**: {'✅ success' if payload['success'] else '❌ ended without success'}\n"
        f"- **Model**: {MODEL}\n"
        f"- **Iterations**: {payload['iters']}\n"
        f"- **Duration**: {payload['duration_s']}s\n"
        f"- **Finished**: {now}\n\n"
        f"## Prompt\n\n{PROMPT}\n\n"
        f"## Summary\n\n{payload['summary']}\n"
    )
    msg = f"task({TASK_ID}): {'success' if payload['success'] else 'finished'}"
    print(tool_write_file(f".holdenmercer/tasks/{TASK_ID}.md", body, msg))


if __name__ == "__main__":
    try:
        result = run()
    except Exception as exc:
        result = {
            "summary":    f"Agent crashed: {type(exc).__name__}: {exc}",
            "success":    False,
            "iters":      0,
            "duration_s": 0,
        }
    print("::group::result")
    print(json.dumps(result, indent=2))
    print("::endgroup::")
    write_result(result)
    # Exit non-zero on failure so the workflow run shows red
    sys.exit(0 if result["success"] else 1)
