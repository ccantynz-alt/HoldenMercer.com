import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from core.config import get_settings
from api.auth import router as auth_router
from api.gateway import router as gateway_router
from api.command import router as command_router
from api.refine import router as refine_router
from api.infra import router as infra_router
from api.voice_config import router as voice_router
from api.health_detail import router as health_detail_router
from api.router import router as cmd_router
from api.console import router as console_router
from api.swarm import router as swarm_router
from api.jobs import router as jobs_router
from api.repo import router as repo_router
from api.gatetest import router as gatetest_router

_settings = get_settings()

logging.basicConfig(
    level=getattr(logging, _settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)

app = FastAPI(
    title="Sovereign AI Engine",
    description="Backend engine + dashboard — resiliency, memory, execution.",
    version="0.2.0",
)

_origins = [o.strip() for o in _settings.allowed_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

# API routes first — must be registered before the SPA catch-all
app.include_router(auth_router)
app.include_router(console_router)
app.include_router(swarm_router)
app.include_router(jobs_router)
app.include_router(repo_router)
app.include_router(gatetest_router)
app.include_router(gateway_router)
app.include_router(command_router)
app.include_router(refine_router)
app.include_router(infra_router)
app.include_router(voice_router)
app.include_router(health_detail_router)
app.include_router(cmd_router)


@app.get("/health", tags=["ops"])
async def health():
    from core.resiliency import check_anthropic_health
    import asyncio
    result = await asyncio.get_running_loop().run_in_executor(None, check_anthropic_health)
    return {"sovereign_engine": "ok", "anthropic": result}


# ── Static frontend (built Vite output) ──────────────────────────────────────
_DIST = Path(__file__).parent.parent / "frontend" / "dist"

if _DIST.exists():
    # Serve /assets/* directly
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        # Let specific static files through (favicon, manifest, etc.)
        candidate = _DIST / full_path
        if candidate.exists() and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_DIST / "index.html")
else:
    @app.get("/", include_in_schema=False)
    async def frontend_not_built():
        return {
            "message": "Frontend not built yet.",
            "next_step": "cd frontend && npm install && npm run build",
        }
