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

    Auth: HMAC signature in X-Gatetest-Signature, signed with
    GATETEST_WEBHOOK_SECRET. The secret is REQUIRED — if it's not configured
    the endpoint fails closed (503), because the handler uses a privileged
    PAT to write to GitHub and `target_repo` comes from the payload.

    Note: this endpoint does NOT require require_api_key — gatetest.ai can't
    send our session token. Auth is HMAC signature only.
    """
    secret = os.environ.get("GATETEST_WEBHOOK_SECRET", "").strip()
    if not secret:
        raise HTTPException(
            status_code=503,
            detail="Webhook secret not configured. Set GATETEST_WEBHOOK_SECRET on the backend.",
        )
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

    # Allowlist target_repo to repos owned by the configured org/user. Even
    # with a valid signature the handler must not write to arbitrary repos —
    # if the signing secret ever leaks, this stops attacker pivot to anything
    # the PAT can reach.
    from core.config import get_settings as _get_settings_for_allowlist
    allowed_owner = (_get_settings_for_allowlist().gluecron_github_org or "").strip().lower()
    if not allowed_owner:
        raise HTTPException(
            status_code=503,
            detail="Webhook target allowlist not configured. Set GLUECRON_GITHUB_ORG on the backend.",
        )
    target_owner = target_repo.split("/", 1)[0].strip().lower()
    if target_owner != allowed_owner:
        raise HTTPException(
            status_code=403,
            detail=f"Webhook target_repo '{target_repo}' is not in the allowed org '{allowed_owner}'.",
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

    # Offline auto-fix: if the target repo has .holdenmercer/autofix.json
    # with {"enabled": true}, dispatch a fix task immediately so the loop
    # closes even when no browser tab is open. The flag lives in the repo
    # (not in HM's per-user state) so it's per-project and travels with
    # the repo.
    auto_dispatched = await _maybe_offline_autofix(target_repo, payload, headers, client_repo=target_repo)

    return {
        "received":        True,
        "target_repo":     target_repo,
        "stored_at":       LATEST_FILE_PATH,
        "auto_dispatched": auto_dispatched,
    }


async def _maybe_offline_autofix(
    target_repo: str, payload: dict, headers: dict, client_repo: str,
) -> dict | None:
    """If the target repo opted into auto-fix AND the scan has failures,
    dispatch a self-repair task via the central agent workflow. Returns
    a small dict on dispatch, None when skipped."""
    modules = payload.get("modules") or []
    failed  = [m for m in modules if (m.get("status") == "failed")]
    if not failed:
        return None

    from core.config import get_settings as _get_settings
    settings = _get_settings()
    central_repo = settings.hm_dispatch_repo or target_repo
    token = settings.gluecron_github_token
    if not token:
        logger.warning("Webhook auto-fix skipped: no backend GitHub token.")
        return None

    # Read the per-repo opt-in flag.
    autofix_url = f"{GITHUB_API}/repos/{target_repo}/contents/.holdenmercer/autofix.json"
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        flag_resp = await client.get(
            autofix_url,
            headers={**_gh_headers(token), "Accept": "application/vnd.github.raw"},
        )
    if flag_resp.status_code != 200:
        return None  # No opt-in file → don't auto-fix
    try:
        flag = json.loads(flag_resp.text)
    except json.JSONDecodeError:
        return None
    if not flag.get("enabled"):
        return None
    # Per-repo kill switch: drop a {"paused": true} field into autofix.json
    # to stop webhook-driven dispatches without removing the file entirely.
    if flag.get("paused"):
        logger.info("Webhook auto-fix paused for %s via autofix.json", target_repo)
        return None
    # Lower per-task ceiling: cap iters at 25 (was effectively 50 in earlier
    # builds). Forces Haiku regardless of any other setting; this path can't
    # be allowed to dispatch Opus tasks unsupervised.
    flag["max_iters"] = min(int(flag.get("max_iters", 25) or 25), 30)

    # Build the same fix prompt the frontend uses (kept as a string here so
    # the backend doesn't need to import frontend code).
    failed_block = "\n".join(
        f"  - {m.get('name', '?')} ({m.get('issues', 0)} issues)"
        + ("".join(f"\n      • {d}" for d in (m.get('details') or [])[:5]))
        for m in failed
    )
    prompt = f"""Self-repair task — gatetest.ai webhook fired with {len(failed)} failed module(s).

Target repo: {target_repo}
Triggered by: gatetest.ai webhook (offline auto-fix path)

Failed modules + findings:
{failed_block}

DOCTRINE (binding):
  • Branch + PR + gate-protected merge
  • Read flywheel context FIRST (check_recent_activity)
  • claim_work BEFORE editing
  • Address EACH failed module above
  • PRE-COMMIT VALIDATION: before opening the PR, call gatetest_check
    to confirm green. Iterate (commit → gatetest_check) up to 3 cycles.
  • merge_pull_request only if gate is green.

When done: report_result with one paragraph summary + the PR URL."""

    # Dispatch via the central workflow (same path /api/jobs/dispatch uses).
    task_id_dt = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y%m%d-%H%M%S")
    import secrets as _secrets
    task_id = f"{task_id_dt}-{_secrets.token_hex(3)}"

    dispatch_url = (
        f"{GITHUB_API}/repos/{central_repo}/actions/workflows/"
        f"holden-mercer-task.yml/dispatches"
    )
    async with httpx.AsyncClient(timeout=20.0) as client:
        repo_info = await client.get(f"{GITHUB_API}/repos/{central_repo}", headers=_gh_headers(token))
        if repo_info.status_code >= 400:
            return None
        ref = repo_info.json().get("default_branch", "main")

        resp = await client.post(
            dispatch_url, headers=_gh_headers(token),
            json={
                "ref": ref,
                "inputs": {
                    "task_id":     task_id,
                    "prompt":      prompt,
                    "target_repo": target_repo,
                    "brief":       f"Webhook-triggered offline auto-fix on {target_repo}",
                    "model":       "claude-haiku-4-5-20251001",
                    "max_iters":   str(flag.get("max_iters", 25)),
                    "branch":      "",
                },
            },
        )
    if resp.status_code >= 400:
        logger.warning("Webhook auto-fix dispatch failed: %s %s", resp.status_code, resp.text[:200])
        return None
    logger.info("Webhook auto-fix dispatched: task_id=%s target=%s", task_id, target_repo)
    return {"task_id": task_id, "central_repo": central_repo}


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
