"""
Gate operations against GitHub Actions.

Four tools, all callable by Claude via the Console tool-use loop:

  setup_gate_workflow(repo)             — write/update the gate workflow file
  run_gate(repo, branch?)               — workflow_dispatch + brief poll for result
  check_gate(repo, run_id)              — poll a specific run for status
  read_gate_logs(repo, run_id, lines?)  — fetch logs of a run (last N lines)

The workflow lives at .github/workflows/holden-mercer-gate.yml. We trigger it
by name (workflow_id = filename in the API) so users can replace the contents
without breaking the integration.

Self-repair flow:
  1. Claude asks for a gate run via run_gate.
  2. The tool waits up to ~45s for the run to finish.
     - If it lands within that window, Claude sees the result inline.
     - Otherwise the tool returns 'in_progress' with a run_id; Claude can
       poll later via check_gate.
  3. On failure Claude calls read_gate_logs to learn what broke, then makes
     a follow-up commit and runs the gate again.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time

import httpx

from api.console_tools import _gh_headers, GITHUB_API, USER_AGENT
from api.gate_workflow import DEFAULT_GATE_WORKFLOW, WORKFLOW_FILENAME, WORKFLOW_PATH

logger = logging.getLogger(__name__)

# Tool schemas exposed to Claude
GATE_TOOL_SCHEMAS: dict[str, dict] = {
    "setup_gate_workflow": {
        "name": "setup_gate_workflow",
        "description": (
            "Install or update the Holden Mercer GitHub Actions gate workflow at "
            ".github/workflows/holden-mercer-gate.yml. Call this once per repo (or "
            "when the user asks to update the gate). After this lands, every push "
            "to a working branch and every run_gate call will run lint + typecheck "
            "+ tests automatically. Returns the URL of the committed file."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":   { "type": "string", "description": "Repository in 'owner/name' form." },
                "branch": { "type": "string", "description": "Optional branch to commit on. Defaults to the repo's default branch." },
            },
            "required": ["repo"],
        },
    },
    "run_gate": {
        "name": "run_gate",
        "description": (
            "Trigger the Holden Mercer gate workflow on a branch and wait briefly "
            "for the result. Returns either the final conclusion (success/failure) "
            "if the run finishes within ~45s, or 'in_progress' with a run_id you "
            "can poll later via check_gate. Use this after committing changes to "
            "verify nothing broke."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":   { "type": "string", "description": "Repository in 'owner/name' form." },
                "branch": { "type": "string", "description": "Branch to run the gate on. Defaults to the repo's default branch." },
            },
            "required": ["repo"],
        },
    },
    "check_gate": {
        "name": "check_gate",
        "description": (
            "Poll a specific gate run by ID. Returns its current status and "
            "conclusion. Use this to follow up on a run_gate call that returned "
            "'in_progress'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":   { "type": "string", "description": "Repository in 'owner/name' form." },
                "run_id": {
                    "anyOf": [
                        {"type": "integer"},
                        {"type": "string"},
                    ],
                    "description": "Workflow run ID returned by run_gate.",
                },
            },
            "required": ["repo", "run_id"],
        },
    },
    "read_gate_logs": {
        "name": "read_gate_logs",
        "description": (
            "Fetch the log output of a gate run, truncated to the last ~120 KB. "
            "Use this on a failed run to see why it failed, then propose / commit "
            "fixes accordingly."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":   { "type": "string", "description": "Repository in 'owner/name' form." },
                "run_id": {
                    "anyOf": [
                        {"type": "integer"},
                        {"type": "string"},
                    ],
                    "description": "Workflow run ID.",
                },
            },
            "required": ["repo", "run_id"],
        },
    },
}

GATE_TOOL_NAMES = set(GATE_TOOL_SCHEMAS.keys())

# run_gate waits for a run to finish for up to this long, polling every 3s.
RUN_POLL_INTERVAL_S = 3.0
RUN_POLL_TIMEOUT_S  = 45.0
LOG_TAIL_BYTES      = 120_000


# ── Dispatcher ──────────────────────────────────────────────────────────────

async def run_gate_tool(name: str, tool_input: dict, github_token: str) -> str:
    if name == "setup_gate_workflow":
        return await _setup_gate_workflow(
            repo=tool_input.get("repo", ""),
            branch=tool_input.get("branch"),
            token=github_token,
        )
    if name == "run_gate":
        return await _run_gate(
            repo=tool_input.get("repo", ""),
            branch=tool_input.get("branch"),
            token=github_token,
        )
    if name == "check_gate":
        return await _check_gate(
            repo=tool_input.get("repo", ""),
            run_id=tool_input.get("run_id"),
            token=github_token,
        )
    if name == "read_gate_logs":
        return await _read_gate_logs(
            repo=tool_input.get("repo", ""),
            run_id=tool_input.get("run_id"),
            token=github_token,
        )
    raise ValueError(f"Unknown gate tool: {name}")


# ── setup_gate_workflow ────────────────────────────────────────────────────

async def _setup_gate_workflow(repo: str, branch: str | None, token: str) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not token:
        raise ValueError("No GitHub token configured.")

    headers = _gh_headers(token)
    url     = f"{GITHUB_API}/repos/{repo}/contents/{WORKFLOW_PATH}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        existing_sha: str | None = None
        get_params = {"ref": branch} if branch else None
        existing = await client.get(url, headers=headers, params=get_params)
        if existing.status_code == 200:
            existing_sha = existing.json().get("sha")

        body = {
            "message": "chore(gate): install Holden Mercer gate workflow",
            "content": base64.b64encode(DEFAULT_GATE_WORKFLOW.encode("utf-8")).decode("ascii"),
        }
        if existing_sha:
            body["sha"] = existing_sha
        if branch:
            body["branch"] = branch

        resp = await client.put(url, headers=headers, json=body)
        if resp.status_code >= 400:
            return f"[error: {resp.status_code} {resp.text[:300]}]"
        data    = resp.json()
        commit  = data.get("commit", {}).get("sha", "")
        action  = "updated" if existing_sha else "installed"
    return (
        f"{action} {WORKFLOW_PATH} in {repo} (commit {commit[:7]}). "
        f"The gate runs on every push to claude/* / holden/* / hm/* branches and "
        f"on workflow_dispatch."
    )


# ── run_gate ────────────────────────────────────────────────────────────────

async def _run_gate(repo: str, branch: str | None, token: str) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not token:
        raise ValueError("No GitHub token configured.")

    headers = _gh_headers(token)

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            target = branch or await _default_branch(client, repo, headers)
        except httpx.HTTPStatusError as exc:
            sc = exc.response.status_code
            if sc == 401:
                # NEVER propagate as 401 — would log the user out via authFetch.
                return (
                    f"[GitHub PAT invalid or expired. Open Settings → Code-host PAT, "
                    f"regenerate with `repo` + `workflow` scopes, and try again.]"
                )
            if sc == 404:
                return (
                    f"[Repo {repo} not found, or your PAT can't access it. "
                    f"Make sure the repo exists and your PAT scope includes it.]"
                )
            return f"[GitHub returned {sc} fetching repo info: {exc.response.text[:200]}]"

        # workflow_dispatch
        dispatch_url = (
            f"{GITHUB_API}/repos/{repo}/actions/workflows/{WORKFLOW_FILENAME}/dispatches"
        )
        dispatch_resp = await client.post(
            dispatch_url, headers=headers, json={"ref": target},
        )
        if dispatch_resp.status_code == 404:
            return (
                f"[Gate workflow not installed in {repo}. Open the project, click "
                f"Tasks tab → Install gate workflow, then try again.]"
            )
        if dispatch_resp.status_code == 401:
            return (
                f"[GitHub PAT invalid or expired. Open Settings → Code-host PAT, "
                f"regenerate with `repo` + `workflow` scopes, and try again.]"
            )
        if dispatch_resp.status_code >= 400:
            return f"[Dispatch failed: GitHub {dispatch_resp.status_code}: {dispatch_resp.text[:200]}]"

        # The dispatch endpoint returns 204 with no body. Find the run we just kicked
        # off by querying the most recent workflow_dispatch run on this branch.
        try:
            run = await _find_recent_run(client, repo, target, headers)
        except httpx.HTTPStatusError as exc:
            sc = exc.response.status_code
            if sc == 401:
                return f"[GitHub PAT invalid or expired during run lookup.]"
            return f"[GitHub returned {sc} looking up the run: {exc.response.text[:200]}]"
        if not run:
            return (
                "[Gate triggered, but no run appeared yet. "
                "Refresh in a few seconds — the workflow takes a moment to register.]"
            )

        # Brief poll so Claude can see fast-finishing runs synchronously
        deadline = time.monotonic() + RUN_POLL_TIMEOUT_S
        while time.monotonic() < deadline:
            if run.get("status") == "completed":
                break
            await asyncio.sleep(RUN_POLL_INTERVAL_S)
            try:
                run = await _get_run(client, repo, run["id"], headers)
            except httpx.HTTPStatusError as exc:
                return f"[Polling failed: GitHub {exc.response.status_code}]"
            if not run:
                return "[Run vanished mid-poll; refresh to see the latest status.]"

    return _format_run(repo, run)


# ── check_gate ──────────────────────────────────────────────────────────────

async def _check_gate(repo: str, run_id, token: str) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not run_id:
        raise ValueError("run_id is required.")
    if not token:
        raise ValueError("No GitHub token configured.")

    async with httpx.AsyncClient(timeout=20.0) as client:
        run = await _get_run(client, repo, run_id, _gh_headers(token))
        if not run:
            return f"[run {run_id} not found in {repo}]"
    return _format_run(repo, run)


# ── read_gate_logs ──────────────────────────────────────────────────────────

async def _read_gate_logs(repo: str, run_id, token: str) -> str:
    if "/" not in repo:
        raise ValueError("repo must be in 'owner/name' form.")
    if not run_id:
        raise ValueError("run_id is required.")
    if not token:
        raise ValueError("No GitHub token configured.")

    headers = _gh_headers(token)
    url     = f"{GITHUB_API}/repos/{repo}/actions/runs/{run_id}/logs"

    # GitHub returns a redirect to a temporary signed S3 URL with a zip of all logs.
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        resp = await client.get(url, headers=headers)
        if resp.status_code == 404:
            return f"[logs not available for run {run_id} (still running?)]"
        if resp.status_code >= 400:
            return f"[error: {resp.status_code} {resp.text[:300]}]"
        zip_bytes = resp.content

    # Extract the largest .txt log so Claude sees the actual gate output, not zip metadata
    try:
        import io
        import zipfile
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            txt_files = [n for n in zf.namelist() if n.endswith(".txt")]
            if not txt_files:
                return "[no .txt logs in archive]"
            # Concatenate all logs, then tail the last LOG_TAIL_BYTES
            blobs: list[str] = []
            for name in txt_files:
                with zf.open(name) as f:
                    text = f.read().decode("utf-8", errors="replace")
                    blobs.append(f"\n────────  {name}  ────────\n{text}")
        full = "".join(blobs)
    except zipfile.BadZipFile:
        return "[response was not a valid zip archive]"

    if len(full) > LOG_TAIL_BYTES:
        full = "[…truncated…]\n" + full[-LOG_TAIL_BYTES:]
    return full


# ── Internals ───────────────────────────────────────────────────────────────

async def _default_branch(client: httpx.AsyncClient, repo: str, headers: dict) -> str:
    r = await client.get(f"{GITHUB_API}/repos/{repo}", headers=headers)
    r.raise_for_status()
    return r.json().get("default_branch", "main")


async def _find_recent_run(
    client: httpx.AsyncClient, repo: str, branch: str, headers: dict,
) -> dict | None:
    """Look up the most recent workflow_dispatch run on this branch. Polls a few times because the run can take a moment to appear."""
    url = f"{GITHUB_API}/repos/{repo}/actions/workflows/{WORKFLOW_FILENAME}/runs"
    for _ in range(8):
        resp = await client.get(
            url, headers=headers,
            params={"event": "workflow_dispatch", "branch": branch, "per_page": 1},
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        runs = resp.json().get("workflow_runs", [])
        if runs:
            return runs[0]
        await asyncio.sleep(2.0)
    return None


async def _get_run(
    client: httpx.AsyncClient, repo: str, run_id, headers: dict,
) -> dict | None:
    resp = await client.get(
        f"{GITHUB_API}/repos/{repo}/actions/runs/{run_id}", headers=headers,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def _format_run(repo: str, run: dict) -> str:
    rid       = run.get("id")
    status    = run.get("status", "?")            # queued | in_progress | completed
    conclude  = run.get("conclusion") or "—"      # success | failure | cancelled | …
    created   = run.get("created_at", "")
    head_sha  = (run.get("head_sha") or "")[:7]
    branch    = run.get("head_branch", "")
    url       = run.get("html_url", "")

    if status == "completed":
        emoji = "✅" if conclude == "success" else "❌"
        return (
            f"{emoji} run {rid} on {repo}@{branch} ({head_sha}) — {conclude}\n"
            f"  URL: {url}\n"
            f"  Started: {created}\n"
            f"  Tip: on failure, call read_gate_logs(repo, run_id={rid}) to see why."
        )
    return (
        f"⏳ run {rid} on {repo}@{branch} ({head_sha}) — status: {status}\n"
        f"  URL: {url}\n"
        f"  Tip: poll with check_gate(repo, run_id={rid}) in a few seconds."
    )
