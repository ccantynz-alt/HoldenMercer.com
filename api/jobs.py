"""
Background jobs — long-running tasks dispatched to GitHub Actions.

Endpoints:
    POST /api/jobs/setup     — install the task workflow + agent runner in a repo
    POST /api/jobs/dispatch  — start a task (returns task_id; the workflow runs async)
    POST /api/jobs/list      — list recent task workflow runs (structured)
    POST /api/jobs/result    — fetch a task's .holdenmercer/tasks/<task_id>.md result

The workflow runs against the user's BYOK Anthropic key, which they must store
once as a repo secret named `ANTHROPIC_API_KEY` (we surface this in the UI).
"""

from __future__ import annotations

import base64
import logging
import secrets
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from core.security import require_api_key
from api.agent_workflow import (
    AGENT_RUNNER_SOURCE,
    RUNNER_PATH,
    TASK_WORKFLOW_FILENAME,
    TASK_WORKFLOW_PATH,
    TASK_WORKFLOW_YAML,
)
from api.cron_workflow import (
    CRON_RUNNER_REPO_PATH,
    CRON_RUNNER_SOURCE,
    CRON_WORKFLOW_PATH,
    CRON_WORKFLOW_YAML,
    SAMPLE_SCHEDULES_YAML,
    SCHEDULES_FILE_PATH,
)
from api.console_tools import GITHUB_API, _gh_headers

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _resolve_token(req_token: str) -> str:
    if req_token:
        return req_token
    from core.config import get_settings
    return get_settings().gluecron_github_token


# ── Request models ──────────────────────────────────────────────────────────

class SetupRequest(BaseModel):
    repo:         str
    branch:       str | None = None
    github_token: str = ""


class DispatchRequest(BaseModel):
    repo:         str
    prompt:       str
    brief:        str  = ""
    model:        str  = "claude-opus-4-7"
    max_iters:    int  = 30
    branch:       str | None = None
    github_token: str  = ""


class ListRequest(BaseModel):
    repo:         str
    branch:       str | None = None
    github_token: str = ""


class ResultRequest(BaseModel):
    repo:         str
    task_id:      str
    branch:       str | None = None
    github_token: str = ""


# ── Helpers ─────────────────────────────────────────────────────────────────

def _new_task_id() -> str:
    """Short, sortable, URL-safe task id."""
    import datetime as dt
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{stamp}-{secrets.token_hex(3)}"


async def _put_file(client: httpx.AsyncClient, repo: str, path: str, content: str,
                    commit_message: str, branch: str | None, headers: dict) -> dict:
    url = f"{GITHUB_API}/repos/{repo}/contents/{path.lstrip('/')}"
    head_params = {"ref": branch} if branch else None
    head = await client.get(url, headers=headers, params=head_params)
    sha  = head.json().get("sha") if head.status_code == 200 else None
    body: dict[str, Any] = {
        "message": commit_message,
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
    }
    if sha:    body["sha"]    = sha
    if branch: body["branch"] = branch
    resp = await client.put(url, headers=headers, json=body)
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=f"Could not write {path}: {resp.text[:300]}")
    return resp.json()


# ── Setup ───────────────────────────────────────────────────────────────────

async def _install_task_workflow_files(
    client: httpx.AsyncClient, repo: str, branch: str | None, headers: dict,
) -> None:
    """Idempotent: writes the workflow + agent runner. Safe to call repeatedly
    — _put_file picks up the existing SHA and replaces in place."""
    await _put_file(
        client, repo, TASK_WORKFLOW_PATH, TASK_WORKFLOW_YAML,
        "chore(tasks): install Holden Mercer background task workflow",
        branch, headers,
    )
    await _put_file(
        client, repo, RUNNER_PATH, AGENT_RUNNER_SOURCE,
        "chore(tasks): install Holden Mercer agent runner",
        branch, headers,
    )


@router.post("/setup", dependencies=[Depends(require_api_key)])
async def setup_task_workflow(req: SetupRequest):
    token = _resolve_token(req.github_token)
    if "/" not in req.repo:
        raise HTTPException(status_code=400, detail="repo must be in 'owner/name' form.")
    if not token:
        raise HTTPException(status_code=400, detail="No GitHub token configured.")

    headers = _gh_headers(token)
    async with httpx.AsyncClient(timeout=30.0) as client:
        await _install_task_workflow_files(client, req.repo, req.branch, headers)

    return {
        "result": (
            f"installed task workflow + agent runner in {req.repo}. "
            "One more step: add your Anthropic API key as a repo secret "
            "named ANTHROPIC_API_KEY at "
            f"https://github.com/{req.repo}/settings/secrets/actions/new"
        ),
        "secret_setup_url": f"https://github.com/{req.repo}/settings/secrets/actions/new",
    }


# ── Dispatch ────────────────────────────────────────────────────────────────

@router.post("/dispatch", dependencies=[Depends(require_api_key)])
async def dispatch_task(req: DispatchRequest):
    token = _resolve_token(req.github_token)
    if "/" not in req.repo:
        raise HTTPException(status_code=400, detail="repo must be in 'owner/name' form.")
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required.")
    if not token:
        raise HTTPException(status_code=400, detail="No GitHub token configured.")

    task_id = _new_task_id()
    headers = _gh_headers(token)

    # Centralized model: dispatch always goes to HM_DISPATCH_REPO (the central
    # repo that hosts the workflow + secrets), regardless of which project repo
    # is the actual TARGET. The workflow uses target_repo to operate cross-repo.
    from core.config import get_settings as _get_settings
    central_repo = _get_settings().hm_dispatch_repo or req.repo
    target_repo  = req.repo  # the project repo the task should edit

    auto_installed = False
    async with httpx.AsyncClient(timeout=30.0) as client:
        # Always dispatch on the central repo's default branch — the workflow
        # itself doesn't care, only the runner cares about target_repo.
        r = await client.get(f"{GITHUB_API}/repos/{central_repo}", headers=headers)
        r.raise_for_status()
        ref = r.json().get("default_branch", "main")

        dispatch_url = (
            f"{GITHUB_API}/repos/{central_repo}/actions/workflows/"
            f"{TASK_WORKFLOW_FILENAME}/dispatches"
        )
        body = {
            "ref":    ref,
            "inputs": {
                "task_id":     task_id,
                "prompt":      req.prompt,
                "target_repo": target_repo,
                "brief":       req.brief or "",
                "model":       req.model,
                "max_iters":   str(req.max_iters),
                "branch":      req.branch or "",
            },
        }
        resp = await client.post(dispatch_url, headers=headers, json=body)
        if resp.status_code == 404:
            # Central workflow missing — install on the central repo this once.
            logger.info("Central task workflow missing in %s — auto-installing", central_repo)
            try:
                await _install_task_workflow_files(client, central_repo, None, headers)
            except HTTPException as exc:
                raise HTTPException(
                    status_code=exc.status_code,
                    detail=(
                        f"Tried to auto-install the central task workflow in {central_repo} "
                        f"but failed: {exc.detail}. Make sure your code-host PAT has "
                        f"`repo` + `workflow` scopes."
                    ),
                ) from exc
            auto_installed = True
            import asyncio
            for delay in (1.0, 2.0, 3.0):
                await asyncio.sleep(delay)
                resp = await client.post(dispatch_url, headers=headers, json=body)
                if resp.status_code != 404:
                    break

        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text[:300])

    return {
        "task_id":     task_id,
        "ref":         ref,
        "target_repo": target_repo,
        "actions_url": f"https://github.com/{central_repo}/actions/workflows/{TASK_WORKFLOW_FILENAME}",
        "auto_installed": auto_installed,
        "secret_setup_url": (
            f"https://github.com/{central_repo}/settings/secrets/actions/new"
            if auto_installed else None
        ),
    }


# ── List ────────────────────────────────────────────────────────────────────

@router.post("/list", dependencies=[Depends(require_api_key)])
async def list_tasks(req: ListRequest):
    """Return the last 25 task workflow runs as structured JSON.

    Centralized model: lists runs from HM_DISPATCH_REPO (where the workflow
    actually runs), not from the project repo. Per-project filtering would
    require fetching each run's inputs, which is too expensive — for now the
    Tasks tab shows all recent task runs across all projects."""
    token = _resolve_token(req.github_token)
    if "/" not in req.repo:
        raise HTTPException(status_code=400, detail="repo must be in 'owner/name' form.")
    if not token:
        raise HTTPException(status_code=400, detail="No GitHub token configured.")

    from core.config import get_settings as _get_settings
    central_repo = _get_settings().hm_dispatch_repo or req.repo

    headers = _gh_headers(token)
    params  = {"per_page": 25}

    url = (
        f"{GITHUB_API}/repos/{central_repo}/actions/workflows/"
        f"{TASK_WORKFLOW_FILENAME}/runs"
    )
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(url, headers=headers, params=params)
        if resp.status_code == 404:
            return {"runs": [], "workflow_installed": False}
        resp.raise_for_status()
        runs = resp.json().get("workflow_runs", [])

    out = [
        {
            "id":         r.get("id"),
            "status":     r.get("status"),
            "conclusion": r.get("conclusion"),
            "branch":     r.get("head_branch"),
            "head_sha":   r.get("head_sha"),
            "created_at": r.get("created_at"),
            "updated_at": r.get("updated_at"),
            "html_url":   r.get("html_url"),
            "actor":      (r.get("triggering_actor") or {}).get("login"),
            "name":       r.get("display_title") or r.get("name"),
        }
        for r in runs
    ]
    return {"runs": out, "workflow_installed": True}


# ── Cron setup ──────────────────────────────────────────────────────────────

@router.post("/setup-cron", dependencies=[Depends(require_api_key)])
async def setup_cron_workflow(req: SetupRequest):
    token = _resolve_token(req.github_token)
    if "/" not in req.repo:
        raise HTTPException(status_code=400, detail="repo must be in 'owner/name' form.")
    if not token:
        raise HTTPException(status_code=400, detail="No GitHub token configured.")

    headers = _gh_headers(token)
    async with httpx.AsyncClient(timeout=30.0) as client:
        # Always (re)write the workflow + runner so updates flow.
        await _put_file(
            client, req.repo, CRON_WORKFLOW_PATH, CRON_WORKFLOW_YAML,
            "chore(cron): install Holden Mercer cron workflow",
            req.branch, headers,
        )
        await _put_file(
            client, req.repo, CRON_RUNNER_REPO_PATH, CRON_RUNNER_SOURCE,
            "chore(cron): install cron evaluator",
            req.branch, headers,
        )

        # Only seed schedules.yml if it doesn't exist yet — never clobber.
        existing = await client.get(
            f"{GITHUB_API}/repos/{req.repo}/contents/{SCHEDULES_FILE_PATH}",
            headers=headers,
            params={"ref": req.branch} if req.branch else None,
        )
        if existing.status_code == 404:
            await _put_file(
                client, req.repo, SCHEDULES_FILE_PATH, SAMPLE_SCHEDULES_YAML,
                "chore(cron): seed schedules.yml",
                req.branch, headers,
            )
            seeded = True
        else:
            seeded = False

    return {
        "result": (
            "installed cron workflow + evaluator. "
            f"Edit `.holdenmercer/schedules.yml` (or ask the Console: "
            f"\"add a schedule that does X every weekday at 9am UTC\"). "
            f"The cron workflow runs every 15 minutes."
        ),
        "schedules_file_seeded": seeded,
        "schedules_url": (
            f"https://github.com/{req.repo}/blob/"
            f"{req.branch or 'HEAD'}/{SCHEDULES_FILE_PATH}"
        ),
    }


# ── Result ──────────────────────────────────────────────────────────────────

@router.post("/result", dependencies=[Depends(require_api_key)])
async def task_result(req: ResultRequest):
    """Fetch the markdown result file the agent committed for a task."""
    token = _resolve_token(req.github_token)
    if "/" not in req.repo:
        raise HTTPException(status_code=400, detail="repo must be in 'owner/name' form.")
    if not req.task_id:
        raise HTTPException(status_code=400, detail="task_id is required.")
    if not token:
        raise HTTPException(status_code=400, detail="No GitHub token configured.")

    headers = {**_gh_headers(token), "Accept": "application/vnd.github.raw"}
    params  = {"ref": req.branch} if req.branch else None
    url     = (
        f"{GITHUB_API}/repos/{req.repo}/contents/"
        f".holdenmercer/tasks/{req.task_id}.md"
    )
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(url, headers=headers, params=params)
        if resp.status_code == 404:
            return {"content": None, "found": False}
        resp.raise_for_status()
    return {"content": resp.text, "found": True}


# ── Cancel + Delete + Readiness ─────────────────────────────────────────────

class RunIdRequest(BaseModel):
    run_id:       int
    github_token: str = ""


@router.post("/cancel", dependencies=[Depends(require_api_key)])
async def cancel_task(req: RunIdRequest):
    """Cancel a running task workflow (centralized model: dispatched into
    HM_DISPATCH_REPO, so the cancel goes there too)."""
    token = _resolve_token(req.github_token)
    if not token:
        raise HTTPException(status_code=400, detail="No GitHub token configured.")
    from core.config import get_settings as _get_settings
    central_repo = _get_settings().hm_dispatch_repo
    headers = _gh_headers(token)
    url = f"{GITHUB_API}/repos/{central_repo}/actions/runs/{req.run_id}/cancel"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(url, headers=headers)
        if resp.status_code >= 400 and resp.status_code != 409:
            # 409 = already finished. We treat it as a no-op success.
            raise HTTPException(status_code=resp.status_code, detail=resp.text[:300])
    return {"cancelled": True, "run_id": req.run_id}


@router.post("/delete-run", dependencies=[Depends(require_api_key)])
async def delete_task_run(req: RunIdRequest):
    """Delete a task workflow run from GitHub Actions history. Cancels first
    if it's still running. The result `.md` file in the project repo (if
    present) is left in place — those are user notes."""
    token = _resolve_token(req.github_token)
    if not token:
        raise HTTPException(status_code=400, detail="No GitHub token configured.")
    from core.config import get_settings as _get_settings
    central_repo = _get_settings().hm_dispatch_repo
    headers = _gh_headers(token)
    async with httpx.AsyncClient(timeout=15.0) as client:
        # Try cancel first — DELETE refuses on in-progress runs
        await client.post(
            f"{GITHUB_API}/repos/{central_repo}/actions/runs/{req.run_id}/cancel",
            headers=headers,
        )
        del_resp = await client.delete(
            f"{GITHUB_API}/repos/{central_repo}/actions/runs/{req.run_id}",
            headers=headers,
        )
        if del_resp.status_code >= 400 and del_resp.status_code != 404:
            raise HTTPException(status_code=del_resp.status_code, detail=del_resp.text[:300])
    return {"deleted": True, "run_id": req.run_id}


class CheckSecretRequest(BaseModel):
    repo:         str
    secret_name:  str = "ANTHROPIC_API_KEY"
    github_token: str = ""


@router.post("/check-secret", dependencies=[Depends(require_api_key)])
async def check_repo_secret(req: CheckSecretRequest):
    """Check whether a repo secret is set. Returns {set: true|false} without
    revealing the value (GitHub's API never returns secret values). Powers the
    Repo Readiness Panel."""
    token = _resolve_token(req.github_token)
    if "/" not in req.repo:
        raise HTTPException(status_code=400, detail="repo must be in 'owner/name' form.")
    if not token:
        raise HTTPException(status_code=400, detail="No GitHub token configured.")
    headers = _gh_headers(token)
    url = f"{GITHUB_API}/repos/{req.repo}/actions/secrets/{req.secret_name}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code == 200:
        return {"set": True, "secret_name": req.secret_name}
    if resp.status_code == 404:
        return {"set": False, "secret_name": req.secret_name}
    if resp.status_code == 403:
        # PAT lacks `secrets:read` — we can't tell. Return unknown.
        return {"set": None, "secret_name": req.secret_name, "reason": "PAT lacks admin scope"}
    raise HTTPException(status_code=resp.status_code, detail=resp.text[:300])
