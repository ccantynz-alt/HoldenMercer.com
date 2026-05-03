"""
Vercel serverless entry — stateless API for the builder console.

Vercel's Python runtime discovers an ASGI `app` exported from a file
under /api and routes ALL /api/* traffic to it. We re-export the
FastAPI app from api.main with one adjustment: the static-file mount
of frontend/dist is skipped because Vercel serves the SPA from
`outputDirectory`, not via FastAPI.

Heavyweight deps (boto3, supabase, celery, redis, sqlalchemy) are NOT
installed in this deploy — see api/requirements.txt. The Bedrock
failover is import-guarded; calling it when boto3 is missing returns
a clean 502.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from core.config import get_settings
from api.gateway import router as gateway_router
from api.command import router as command_router
from api.refine import router as refine_router
from api.infra import router as infra_router
from api.voice_config import router as voice_router
from api.health_detail import router as health_detail_router
from api.router import router as cmd_router

_settings = get_settings()

logging.basicConfig(
    level=getattr(logging, _settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)

app = FastAPI(
    title="HoldenMercer.com — Builder Console API",
    description="Stateless endpoints for the AI website builder console.",
    version="0.3.0-vercel",
)

_origins = [o.strip() for o in _settings.allowed_origins.split(",") if o.strip()]
_origins.append("https://www.holdenmercer.com")
_origins.append("https://holdenmercer.com")

# Vercel preview deploys land on *.vercel.app — Starlette's allow_origins is
# literal-match only, so wildcards belong in allow_origin_regex.
_VERCEL_PREVIEW_RE = r"https://[a-z0-9-]+\.vercel\.app"

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=_VERCEL_PREVIEW_RE,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(gateway_router)
app.include_router(command_router)
app.include_router(refine_router)
app.include_router(infra_router)
app.include_router(voice_router)
app.include_router(health_detail_router)
app.include_router(cmd_router)


_HEALTH_BODY = {
    "ok":          True,
    "deploy":      "vercel",
    "websocket":   False,
    "bedrock":     False,
    "note":        "Stateless endpoints. Bedrock + heavy memory land on CronTech.",
    "anthropic":   {"ok": True, "latency_ms": None, "detail": "skipped on Vercel"},
}


@app.get("/api/health", tags=["ops"])
async def health_api():
    """Liveness probe. Skips the Anthropic round-trip so it stays fast."""
    return _HEALTH_BODY


@app.get("/health", tags=["ops"])
async def health_root():
    """Frontend StatusBar polls this at /health (no /api prefix)."""
    return _HEALTH_BODY
