"""
Infrastructure API — GlueCron memory + CronTech deployments.

Routes:
  GET  /api/infra/repos            — list GlueCron repos
  POST /api/infra/index            — embed all repos into pgvector
  POST /api/infra/search           — semantic search
  GET  /api/infra/instances        — list CronTech instances
  POST /api/infra/deploy           — deploy + Shadow Architect loop (SSE stream)
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core.security import require_api_key

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/infra", tags=["infra"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class SearchRequest(BaseModel):
    query: str
    top_k: int = Field(5, ge=1, le=20)
    repo_filter: str | None = None


class DeployRequest(BaseModel):
    repo: str
    instance_name: str
    env_vars: dict[str, str] = {}
    dry_run: bool = Field(True, description="Set false to actually trigger CronTech.")
    shadow_loop: bool = Field(False, description="Run Shadow Architect debug loop after deploy.")


class IndexRequest(BaseModel):
    repos: list[str] | None = None   # None = index all repos


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/repos", dependencies=[Depends(require_api_key)])
async def list_repos():
    """List all GlueCron repos (GitHub API)."""
    def _run():
        from services.infra_bridge import GlueCronClient
        gc = GlueCronClient()
        repos = gc.list_repos()
        return [
            {"name": r["name"], "description": r.get("description"), "updated_at": r.get("updated_at")}
            for r in repos
        ]

    loop = asyncio.get_running_loop()
    repos = await loop.run_in_executor(None, _run)
    return {"repos": repos, "count": len(repos)}


@router.post("/index", dependencies=[Depends(require_api_key)])
async def index_repos(req: IndexRequest):
    """Embed GlueCron repos into Supabase pgvector. Can take several minutes."""
    def _run():
        from services.infra_bridge import index_repos as _index
        return _index(repos=req.repos)

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, _run)
    return result


@router.post("/search", dependencies=[Depends(require_api_key)])
async def semantic_search(req: SearchRequest):
    """Semantic search across all indexed GlueCron files."""
    def _run():
        from services.infra_bridge import semantic_search as _search
        return _search(req.query, top_k=req.top_k, repo_filter=req.repo_filter)

    loop = asyncio.get_running_loop()
    results = await loop.run_in_executor(None, _run)
    return {
        "query": req.query,
        "results": [
            {"repo": r.repo, "path": r.path, "snippet": r.snippet, "similarity": round(r.similarity, 4)}
            for r in results
        ],
    }


@router.get("/instances", dependencies=[Depends(require_api_key)])
async def list_instances():
    """List running CronTech instances."""
    def _run():
        from services.infra_bridge import CronTechClient
        return CronTechClient().list_instances()

    loop = asyncio.get_running_loop()
    instances = await loop.run_in_executor(None, _run)
    return {"instances": instances}


@router.post("/deploy", dependencies=[Depends(require_api_key)])
async def deploy(req: DeployRequest):
    """
    SSE stream — streams agent events as the deployment proceeds.

    Event types: architect_start, coder_start, deploy_start, deploy_status,
                 shadow_iter, auditor_start, done, error
    """
    return StreamingResponse(
        _deploy_stream(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# SSE deployment stream
# ---------------------------------------------------------------------------

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def _deploy_stream(req: DeployRequest) -> AsyncIterator[str]:
    loop = asyncio.get_running_loop()

    # ── Architect: plan ──────────────────────────────────────────────────────
    yield _sse("architect_start", {
        "agent": "Architect",
        "message": f"Analysing deployment plan for {req.repo} → {req.instance_name}",
    })
    await asyncio.sleep(0)   # flush

    # ── Coder: semantic search for best match ────────────────────────────────
    yield _sse("coder_start", {
        "agent": "Coder",
        "message": "Searching GlueCron memory for best matching files…",
    })

    try:
        results = await loop.run_in_executor(None, lambda: _semantic_search_safe(req.repo, req.instance_name))
    except Exception as exc:
        yield _sse("error", {"agent": "Coder", "message": str(exc)})
        return

    if results:
        yield _sse("coder_start", {
            "agent": "Coder",
            "message": f"Best match: {results[0]['repo']}/{results[0]['path']} ({results[0]['similarity']:.1%})",
        })

    # ── Deploy ───────────────────────────────────────────────────────────────
    yield _sse("deploy_start", {
        "agent": "Coder",
        "message": f"Triggering CronTech deployment (dry_run={req.dry_run})…",
    })

    try:
        deploy_result = await loop.run_in_executor(None, lambda: _deploy_safe(req))
    except Exception as exc:
        yield _sse("error", {"agent": "Coder", "message": str(exc)})
        return

    yield _sse("deploy_status", {
        "agent": "Coder",
        "deployment_id": deploy_result["deployment_id"],
        "status": deploy_result["status"],
        "url": deploy_result["url"],
    })

    # ── Shadow Architect loop (if requested + deployment succeeded) ──────────
    if req.shadow_loop and not req.dry_run and deploy_result["status"] == "succeeded":
        yield _sse("shadow_iter", {
            "agent": "Architect",
            "message": "Shadow Architect: validating deployed instance…",
            "iteration": 0,
        })

        try:
            shadow = await loop.run_in_executor(None, lambda: _run_shadow_loop(deploy_result, req))
            yield _sse("shadow_iter", {
                "agent": "Architect",
                "message": f"Shadow loop complete: success={shadow['success']} in {shadow['iterations']} iterations",
                "success": shadow["success"],
                "iterations": shadow["iterations"],
                "log": shadow["debug_log"],
            })
        except Exception as exc:
            yield _sse("shadow_iter", {"agent": "Architect", "message": f"Shadow loop error: {exc}", "success": False})

    # ── Auditor: verify ──────────────────────────────────────────────────────
    yield _sse("auditor_start", {
        "agent": "Auditor",
        "message": "Deployment verified." if deploy_result["status"] in ("succeeded", "dry_run") else "Deployment needs attention.",
        "status": deploy_result["status"],
    })

    yield _sse("done", {
        "message": "Pipeline complete.",
        "deployment": deploy_result,
    })


def _semantic_search_safe(repo: str, query: str) -> list[dict]:
    try:
        from services.infra_bridge import semantic_search
        results = semantic_search(query, top_k=3, repo_filter=repo)
        return [{"repo": r.repo, "path": r.path, "similarity": r.similarity} for r in results]
    except Exception:
        return []   # non-fatal — deploy can proceed without search context


def _deploy_safe(req: DeployRequest) -> dict:
    from services.infra_bridge import CronTechClient
    client = CronTechClient()
    result = client.deploy(
        repo=req.repo,
        instance_name=req.instance_name,
        env_vars=req.env_vars,
        dry_run=req.dry_run,
    )
    return {
        "deployment_id": result.deployment_id,
        "status": result.status,
        "url": result.url,
        "logs": result.logs,
    }


def _run_shadow_loop(deploy_result: dict, req: DeployRequest) -> dict:
    from services.infra_bridge import shadow_architect_loop, CronTechClient

    crontech = CronTechClient()
    instance_url = deploy_result.get("url", "")

    def health_check(code: str) -> tuple[bool, str]:
        # Validate by checking the deployed instance is healthy
        if not instance_url:
            return False, "No URL — cannot health-check."
        try:
            import httpx
            r = httpx.get(instance_url, timeout=10)
            if r.status_code < 400:
                return True, f"HTTP {r.status_code} OK"
            return False, f"HTTP {r.status_code}: {r.text[:200]}"
        except Exception as exc:
            return False, str(exc)

    result = shadow_architect_loop(
        task=f"Ensure {req.repo} is deployed and healthy at {instance_url}",
        initial_code=f"# Deployment: {req.repo} → {req.instance_name}\n# URL: {instance_url}",
        validator=health_check,
        max_iterations=5,
    )
    return {
        "success": result.success,
        "iterations": result.iterations,
        "debug_log": result.debug_log,
        "error": result.error,
    }
