"""
GET /api/voice/config — returns the active provider's WebSocket connection config.

The frontend calls this once on mount instead of reading VITE_DEEPGRAM_API_KEY
directly, which means flipping INFRA_MODE=CRONTECH in .env is the only change
needed to switch the entire voice pipeline.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from api.providers import get_voice_provider
from core.security import require_api_key

router = APIRouter(prefix="/api/voice", tags=["voice"])


class VoiceConfigResponse(BaseModel):
    provider: str
    ws_url: str
    auth_token: str
    model: str
    features: dict


@router.get("/config", dependencies=[Depends(require_api_key)])
async def voice_config() -> VoiceConfigResponse:
    """
    Returns the WebSocket URL, auth token, and model info for the active provider.
    Frontend usage:
        const cfg = await GET /api/voice/config
        new WebSocket(cfg.ws_url, ['token', cfg.auth_token])
    """
    loop = asyncio.get_running_loop()
    provider = get_voice_provider()
    config = await loop.run_in_executor(None, provider.get_config)
    return VoiceConfigResponse(
        provider=config.provider,
        ws_url=config.ws_url,
        auth_token=config.auth_token,
        model=config.model,
        features=config.features,
    )
