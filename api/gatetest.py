"""
gatetest.ai integration — proxy endpoint that calls the user's gatetest.ai API.

The user's gt_live_... key is stored in the SPA (Settings → gatetest.ai) and
sent in each request body. Backend forwards to gatetest.ai/api/v1 and returns
the structured findings to the dashboard.

Why proxy instead of calling direct from the browser:
  • CORS — gatetest.ai may not whitelist arbitrary origins
  • Centralised error normalization (401 → 502 so the SPA doesn't logout)
  • Request shape stability if gatetest.ai's API evolves
"""

from __future__ import annotations

import logging
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.security import require_api_key

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/gatetest", tags=["gatetest"])

GATETEST_API = "https://gatetest.ai/api/v1"


class ScanRequest(BaseModel):
    repo_url:     str
    tier:         Literal["quick", "full"] = "full"
    gatetest_key: str = ""


@router.post("/scan", dependencies=[Depends(require_api_key)])
async def scan(req: ScanRequest) -> dict[str, Any]:
    """Trigger a gatetest.ai scan against a GitHub repo.

    The dashboard sends the user's gt_live_... key in the request body.
    Latency: 5-15s for tier=quick, 20-60s for tier=full (per gatetest.ai docs)."""
    if not req.gatetest_key.strip():
        raise HTTPException(
            status_code=400,
            detail="No gatetest.ai key configured. Open Settings → gatetest.ai.",
        )
    if not req.repo_url.startswith("http"):
        raise HTTPException(
            status_code=400,
            detail="repo_url must be a full GitHub URL (https://github.com/owner/name).",
        )

    headers = {
        "Authorization": f"Bearer {req.gatetest_key.strip()}",
        "Content-Type":  "application/json",
        "User-Agent":    "Holden Mercer Dashboard",
    }
    body = {"repo_url": req.repo_url, "tier": req.tier}

    # Full tier can take up to 60s — give httpx a generous timeout.
    async with httpx.AsyncClient(timeout=90.0) as client:
        try:
            resp = await client.post(f"{GATETEST_API}/scan", headers=headers, json=body)
        except httpx.HTTPError as exc:
            logger.exception("gatetest.ai request failed")
            raise HTTPException(status_code=502, detail=f"gatetest.ai unreachable: {exc}")

    # Map upstream errors to our 502 so they don't trigger the SPA's authFetch
    # auto-logout (which fires on any 401, regardless of source).
    if resp.status_code == 401:
        raise HTTPException(
            status_code=502,
            detail="gatetest.ai key invalid or expired. Update in Settings → gatetest.ai.",
        )
    if resp.status_code == 403:
        raise HTTPException(
            status_code=502,
            detail="gatetest.ai key revoked or tier not authorised for this scan.",
        )
    if resp.status_code == 429:
        raise HTTPException(
            status_code=502,
            detail="gatetest.ai rate limit hit. Wait a moment and try again.",
        )
    if resp.status_code == 502:
        raise HTTPException(
            status_code=502,
            detail="gatetest.ai couldn't access the repo. Install the gatetest.ai GitHub App or make the repo public.",
        )
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"gatetest.ai returned {resp.status_code}: {resp.text[:300]}",
        )

    return resp.json()
