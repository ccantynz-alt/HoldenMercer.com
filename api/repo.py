"""
Repo proxy — frontend-friendly endpoints for GitHub read/write.

These wrap the same GitHub API helpers Claude's tools use, but expose them as
plain REST so the frontend can sync the project Brief, save session summaries,
and render the Memory tab without going through a chat turn.

All endpoints require the dashboard session (Bearer token). The GitHub PAT is
sent per-request in the body or query — same model as BYOK Anthropic in
api/console.py: nothing persistent server-side.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from core.security import require_api_key
from api.console_tools import (
    _fetch_github_dir,
    _fetch_github_repos,
    _gh_headers,
    GITHUB_API,
    _read_github_file,
    _write_github_file,
)
from api.gate_tools import (
    _check_gate,
    _read_gate_logs,
    _run_gate,
    _setup_gate_workflow,
)
from api.gate_workflow import WORKFLOW_FILENAME

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/repo", tags=["repo"])


class WriteFileRequest(BaseModel):
    repo:           str
    path:           str
    content:        str
    commit_message: str = "Update via Holden Mercer"
    branch:         str | None = None
    github_token:   str  = Field(default="")


class ReadFileRequest(BaseModel):
    repo:         str
    path:         str
    ref:          str | None = None
    github_token: str = ""


class ListDirRequest(BaseModel):
    repo:         str
    path:         str = ""
    ref:          str | None = None
    github_token: str = ""


class ListReposRequest(BaseModel):
    search:       str | None = None
    org:          str | None = None
    github_token: str = ""


def _resolve_token(req_token: str) -> str:
    """Per-request token wins; otherwise fall back to the env-configured one."""
    if req_token:
        return req_token
    from core.config import get_settings
    return get_settings().gluecron_github_token


@router.post("/file/read", dependencies=[Depends(require_api_key)])
async def read_file(req: ReadFileRequest):
    token = _resolve_token(req.github_token)
    try:
        content = await _read_github_file(req.repo, req.path, req.ref, token)
        return {"content": content}
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.post("/file/write", dependencies=[Depends(require_api_key)])
async def write_file(req: WriteFileRequest):
    token = _resolve_token(req.github_token)
    try:
        result = await _write_github_file(
            repo=req.repo,
            path=req.path,
            content=req.content,
            commit_message=req.commit_message,
            branch=req.branch,
            token=token,
        )
        return {"result": result}
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.post("/dir", dependencies=[Depends(require_api_key)])
async def list_dir(req: ListDirRequest):
    token = _resolve_token(req.github_token)
    try:
        items = await _fetch_github_dir(req.repo, req.path, req.ref, token)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    out = [
        {
            "name": it.get("name"),
            "path": it.get("path"),
            "type": it.get("type"),
            "size": it.get("size", 0),
            "sha":  it.get("sha"),
            "html_url": it.get("html_url"),
        }
        for it in items
    ]
    return {"items": out}


@router.post("/repos", dependencies=[Depends(require_api_key)])
async def list_repos(req: ListReposRequest):
    token = _resolve_token(req.github_token)
    from core.config import get_settings
    org = req.org or get_settings().gluecron_github_org
    try:
        repos = await _fetch_github_repos(token, org)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    needle = (req.search or "").lower().strip()
    out = []
    for r in repos:
        name = r.get("name", "")
        if needle and needle not in name.lower():
            continue
        out.append({
            "full_name":  r.get("full_name"),
            "name":       name,
            "private":    bool(r.get("private")),
            "description": r.get("description") or "",
            "default_branch": r.get("default_branch") or "main",
            "updated_at": r.get("updated_at"),
            "html_url":   r.get("html_url"),
        })
    return {"repos": out}


# ── Gate (GitHub Actions) ───────────────────────────────────────────────────

class GateSetupRequest(BaseModel):
    repo:         str
    branch:       str | None = None
    github_token: str = ""


class GateRunRequest(BaseModel):
    repo:         str
    branch:       str | None = None
    github_token: str = ""


class GateStatusRequest(BaseModel):
    repo:         str
    run_id:       int | str
    github_token: str = ""


class GateLogsRequest(BaseModel):
    repo:         str
    run_id:       int | str
    github_token: str = ""


class GateListRequest(BaseModel):
    repo:         str
    github_token: str = ""
    branch:       str | None = None


@router.post("/gate/setup", dependencies=[Depends(require_api_key)])
async def gate_setup(req: GateSetupRequest):
    token = _resolve_token(req.github_token)
    try:
        result = await _setup_gate_workflow(req.repo, req.branch, token)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return {"result": result}


@router.post("/gate/run", dependencies=[Depends(require_api_key)])
async def gate_run(req: GateRunRequest):
    """Manually trigger a gate run from the Gate tab."""
    token = _resolve_token(req.github_token)
    try:
        result = await _run_gate(req.repo, req.branch, token)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return {"result": result}


@router.post("/gate/status", dependencies=[Depends(require_api_key)])
async def gate_status(req: GateStatusRequest):
    token = _resolve_token(req.github_token)
    try:
        result = await _check_gate(req.repo, req.run_id, token)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return {"result": result}


@router.post("/gate/logs", dependencies=[Depends(require_api_key)])
async def gate_logs(req: GateLogsRequest):
    token = _resolve_token(req.github_token)
    try:
        logs = await _read_gate_logs(req.repo, req.run_id, token)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return {"logs": logs}


@router.post("/gate/runs", dependencies=[Depends(require_api_key)])
async def gate_runs(req: GateListRequest):
    """
    List the most recent gate runs as structured JSON for the Gate tab UI.
    Limited to the last 25 to keep payload sane.
    """
    import httpx

    token = _resolve_token(req.github_token)
    if "/" not in req.repo:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="repo must be 'owner/name'.")
    if not token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No GitHub token configured.")

    headers = _gh_headers(token)
    params = {"per_page": 25}
    if req.branch:
        params["branch"] = req.branch
    url = f"{GITHUB_API}/repos/{req.repo}/actions/workflows/{WORKFLOW_FILENAME}/runs"

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
            "event":      r.get("event"),
            "actor":      (r.get("triggering_actor") or {}).get("login"),
        }
        for r in runs
    ]
    return {"runs": out, "workflow_installed": True}
