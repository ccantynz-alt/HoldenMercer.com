"""
gatetest.ai integration — proxy endpoint that calls the user's gatetest.ai API,
PLUS a webhook receiver that lets gatetest.ai push scan results to HM
asynchronously.

Three endpoints:

  POST /api/gatetest/scan      — proxy to gatetest.ai/api/v1/scan (synchronous)
  POST /api/gatetest/webhook   — gatetest.ai → HM async push of scan results
  POST /api/gatetest/latest    — read the most-recent scan for a repo from
                                 .holdenmercer/gatetest-latest.json in that repo

Webhook flow:
  1. User configures gatetest.ai with the URL: https://www.holdenmercer.com/api/gatetest/webhook
  2. gatetest.ai posts scan results there as JSON
  3. We persist to .holdenmercer/gatetest-latest.json in the target repo (so
     the repo is the database; results survive serverless cold starts)
  4. Frontend reads the file on Gate-tab open + after each manual scan
"""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from core.security import require_api_key
from api.console_tools import GITHUB_API, _gh_headers

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/gatetest", tags=["gatetest"])

# Default API base. Per the public docs, both gatetest.ai and gatetest.io
# advertise the same /api/v1/scan endpoint. We try the user-supplied override
# first, fall back to the known-good public URL.
DEFAULT_GATETEST_API = "https://www.gatetest.ai/api/v1"
FALLBACK_BASES = [
    "https://www.gatetest.ai/api/v1",
    "https://gatetest.ai/api/v1",
    "https://gatetest.io/api/v1",
    "https://api.gatetest.ai/v1",
]


class ScanRequest(BaseModel):
    repo_url:     str
    tier:         Literal["quick", "full"] = "full"
    gatetest_key: str = ""
    # Optional override of the API base URL — for self-hosted gatetest.ai.
    api_base:     str = ""


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

    # Try the user's override first (if any), then walk fallback bases until
    # one returns a non-404. Some gatetest.ai install variants expose the API
    # at different subdomains (gatetest.ai, www.gatetest.ai, gatetest.io,
    # api.gatetest.ai) so we probe instead of failing on the first 404.
    bases = [req.api_base.strip()] if req.api_base.strip() else []
    for b in FALLBACK_BASES:
        if b not in bases:
            bases.append(b)

    last_404_body = ""
    resp = None
    async with httpx.AsyncClient(timeout=90.0, follow_redirects=True) as client:
        for base in bases:
            url = f"{base.rstrip('/')}/scan"
            try:
                attempt = await client.post(url, headers=headers, json=body)
            except httpx.HTTPError as exc:
                logger.warning("gatetest.ai POST to %s failed: %s", url, exc)
                continue
            if attempt.status_code == 404:
                last_404_body = attempt.text[:200]
                logger.info("gatetest.ai 404 at %s — trying next base", url)
                continue
            resp = attempt
            break

    if resp is None:
        raise HTTPException(
            status_code=502,
            detail=(
                f"gatetest.ai scan endpoint not found at any known base "
                f"({', '.join(bases)}). The API may be unavailable or your "
                f"tier may not include scans yet. Last response: {last_404_body or 'no response'}"
            ),
        )

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


# ── Webhook receiver ────────────────────────────────────────────────────────

LATEST_FILE_PATH = ".holdenmercer/gatetest-latest.json"


def _extract_target_repo(payload: dict) -> str | None:
    """Pull the GitHub owner/name from a webhook payload. gatetest.ai may use
    different field names depending on tier/version; try the most likely keys
    in order of specificity."""
    repo_url = payload.get("repo_url") or payload.get("repository") or payload.get("repo")
    if not repo_url:
        return None
    # Strip "https://github.com/" / ".git" / trailing slashes; tolerate either
    # the URL form or "owner/name" form.
    s = str(repo_url).strip()
    for prefix in ("https://github.com/", "http://github.com/", "git@github.com:"):
        if s.startswith(prefix):
            s = s[len(prefix):]
            break
    s = s.rstrip("/")
    if s.endswith(".git"):
        s = s[:-4]
    return s if "/" in s else None


@router.post("/webhook")
async def receive_webhook(
    payload: dict,
    x_gatetest_signature: str | None = Header(default=None),
):
    """Receive a scan result from gatetest.ai. Persists to
    .holdenmercer/gatetest-latest.json in the target repo so the dashboard
    can read it without polling gatetest.ai's API.

    Auth: optional HMAC signature in X-Gatetest-Signature. If
    GATETEST_WEBHOOK_SECRET env var is set on the backend, signature must
    match. Otherwise we accept the payload (open mode — fine for single-user).

    Note: this endpoint does NOT require require_api_key — gatetest.ai can't
    send our session token. Anyone can POST. Mitigation: HMAC signature when
    a secret is configured.
    """
    secret = os.environ.get("GATETEST_WEBHOOK_SECRET", "").strip()
    if secret:
        import hashlib
        import hmac
        expected = hmac.new(
            secret.encode("utf-8"),
            json.dumps(payload, sort_keys=True).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        provided = (x_gatetest_signature or "").replace("sha256=", "").strip()
        if not hmac.compare_digest(expected, provided):
            raise HTTPException(status_code=401, detail="Invalid webhook signature.")

    target_repo = _extract_target_repo(payload)
    if not target_repo:
        raise HTTPException(
            status_code=400,
            detail="Webhook payload missing repo_url / repository / repo field.",
        )

    # Persist to the target repo. Uses the centrally-configured PAT so we
    # can write to repos the user owns.
    from core.config import get_settings as _get_settings
    token = _get_settings().gluecron_github_token
    if not token:
        raise HTTPException(
            status_code=500,
            detail="No backend GitHub token configured (env GLUECRON_GITHUB_TOKEN). Webhook can't persist results.",
        )
    headers = _gh_headers(token)

    contents_url = f"{GITHUB_API}/repos/{target_repo}/contents/{LATEST_FILE_PATH}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        # Need the existing SHA to overwrite (Contents API requirement).
        head = await client.get(contents_url, headers=headers)
        sha = head.json().get("sha") if head.status_code == 200 else None

        body: dict[str, Any] = {
            "message": "chore(gatetest): record latest scan results",
            "content": base64.b64encode(
                json.dumps(payload, indent=2).encode("utf-8")
            ).decode("ascii"),
        }
        if sha:
            body["sha"] = sha

        write = await client.put(contents_url, headers=headers, json=body)
        if write.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail=f"Could not persist webhook to {target_repo}: {write.status_code} {write.text[:200]}",
            )

    logger.info(
        "gatetest.ai webhook persisted: repo=%s totalIssues=%s modules=%s",
        target_repo,
        payload.get("totalIssues"),
        len(payload.get("modules", [])),
    )
    return {"received": True, "target_repo": target_repo, "stored_at": LATEST_FILE_PATH}


class LatestRequest(BaseModel):
    repo:         str
    branch:       str | None = None
    github_token: str = ""


@router.post("/latest", dependencies=[Depends(require_api_key)])
async def get_latest(req: LatestRequest):
    """Read the most-recent webhook-pushed scan for a repo. Returns the
    payload as gatetest.ai sent it, or {found: false} if no scan has been
    received yet."""
    if "/" not in req.repo:
        raise HTTPException(status_code=400, detail="repo must be 'owner/name'.")
    token = req.github_token or ""
    if not token:
        from core.config import get_settings as _get_settings
        token = _get_settings().gluecron_github_token
    if not token:
        raise HTTPException(status_code=400, detail="No GitHub token configured.")

    headers = {**_gh_headers(token), "Accept": "application/vnd.github.raw"}
    params = {"ref": req.branch} if req.branch else None
    url = f"{GITHUB_API}/repos/{req.repo}/contents/{LATEST_FILE_PATH}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, headers=headers, params=params)
    if resp.status_code == 404:
        return {"found": False}
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Could not read latest scan: GitHub {resp.status_code}",
        )
    try:
        return {"found": True, "payload": json.loads(resp.text)}
    except json.JSONDecodeError:
        return {"found": False, "error": "stored file isn't valid JSON"}
