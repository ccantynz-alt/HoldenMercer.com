"""
Detailed health endpoints for the System Health widget.

GET /api/health/system   — combined: engine uptime + all providers + GlueCron
GET /api/health/voice    — active voice provider latency
GET /api/health/gluecron — GlueCron last sync status
"""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter

router = APIRouter(prefix="/api/health", tags=["health"])

_START_TIME = time.monotonic()


@router.get("/system")
async def system_health():
    """Combined health snapshot — polled by the frontend SystemHealth widget."""
    loop = asyncio.get_running_loop()

    # Run all checks concurrently
    voice_task    = loop.run_in_executor(None, _check_voice)
    gluecron_task = loop.run_in_executor(None, _check_gluecron)
    engine_task   = loop.run_in_executor(None, _check_engine)

    voice, gluecron, engine = await asyncio.gather(
        voice_task, gluecron_task, engine_task, return_exceptions=True
    )

    def _safe(result, label: str) -> dict:
        if isinstance(result, Exception):
            return {"ok": False, "latency_ms": None, "detail": str(result), "label": label}
        return result

    return {
        "uptime_s": int(time.monotonic() - _START_TIME),
        "engine":   _safe(engine, "Sovereign Engine"),
        "voice":    _safe(voice, "Voice Provider"),
        "gluecron": _safe(gluecron, "GlueCron"),
    }


@router.get("/voice")
async def voice_health():
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _check_voice)


@router.get("/gluecron")
async def gluecron_health():
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _check_gluecron)


# ---------------------------------------------------------------------------
# Individual check functions (run in thread pool — all use blocking httpx)
# ---------------------------------------------------------------------------

def _check_voice() -> dict:
    from api.providers import get_voice_provider
    provider = get_voice_provider()
    result = provider.health_check()
    result["label"] = f"Voice ({provider.name})"
    result["provider"] = provider.name
    return result


def _check_gluecron() -> dict:
    from core.config import get_settings
    s = get_settings()
    if not s.gluecron_github_token or not s.gluecron_github_org:
        return {
            "ok": False, "latency_ms": None,
            "detail": "GLUECRON_GITHUB_TOKEN / ORG not configured",
            "label": "GlueCron", "last_sync": None,
        }
    import httpx, time as _time
    t0 = _time.monotonic()
    try:
        resp = httpx.get(
            f"https://api.github.com/users/{s.gluecron_github_org}",
            headers={
                "Authorization": f"Bearer {s.gluecron_github_token}",
                "Accept": "application/vnd.github+json",
            },
            timeout=5,
        )
        latency = int((_time.monotonic() - t0) * 1000)
        ok = resp.status_code == 200
        return {
            "ok": ok,
            "latency_ms": latency,
            "detail": "ok" if ok else f"HTTP {resp.status_code}",
            "label": "GlueCron",
            "org": s.gluecron_github_org,
            "staging": s.gluecron_staging,
        }
    except Exception as exc:
        return {"ok": False, "latency_ms": None, "detail": str(exc), "label": "GlueCron"}


def _check_engine() -> dict:
    from core.resiliency import check_anthropic_health
    return check_anthropic_health()
