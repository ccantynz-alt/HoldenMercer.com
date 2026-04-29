"""Deepgram nova-2 voice provider."""

from __future__ import annotations

import time

import httpx

from api.providers.base import VoiceConfig, VoiceProvider
from core.config import get_settings

_DG_WSS  = "wss://api.deepgram.com/v1/listen"
_DG_REST = "https://api.deepgram.com/v1/projects"

_PARAMS = {
    "model":           "nova-2",
    "smart_format":    "true",
    "punctuate":       "true",
    "interim_results": "true",
    "endpointing":     "300",
}


class DeepgramProvider(VoiceProvider):
    @property
    def name(self) -> str:
        return "deepgram"

    def get_config(self) -> VoiceConfig:
        s = get_settings()
        key = s.deepgram_api_key
        if not key:
            raise RuntimeError(
                "DEEPGRAM_API_KEY is not set. Add it to .env or set INFRA_MODE=CRONTECH."
            )
        qs = "&".join(f"{k}={v}" for k, v in _PARAMS.items())
        return VoiceConfig(
            provider="deepgram",
            ws_url=f"{_DG_WSS}?{qs}",
            auth_token=key,
            model="nova-2",
            features={"filler_words": False, "endpointing_ms": 300},
        )

    def health_check(self) -> dict:
        s = get_settings()
        key = s.deepgram_api_key
        if not key:
            return {"ok": False, "latency_ms": None, "detail": "DEEPGRAM_API_KEY not set"}
        t0 = time.monotonic()
        try:
            resp = httpx.get(
                _DG_REST,
                headers={"Authorization": f"Token {key}"},
                timeout=5,
            )
            latency = int((time.monotonic() - t0) * 1000)
            if resp.status_code == 200:
                return {"ok": True, "latency_ms": latency, "detail": "ok"}
            return {"ok": False, "latency_ms": latency, "detail": f"HTTP {resp.status_code}"}
        except Exception as exc:
            return {"ok": False, "latency_ms": None, "detail": str(exc)}
