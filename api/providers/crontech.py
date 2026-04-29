"""
CronTechProvider — drop-in replacement for Deepgram.

Assumes CronTech exposes a nova-2-compatible WebSocket at:
  wss://<crontech_voice_url>/v1/listen

The same query-param contract as Deepgram is used so the frontend
WebSocket code doesn't need to change when INFRA_MODE=CRONTECH.

TODO: Update _PARAMS and _WSS_PATH once the CronTech voice API spec
      is available. Current values mirror the Deepgram interface.
"""

from __future__ import annotations

import time

import httpx

from api.providers.base import VoiceConfig, VoiceProvider
from core.config import get_settings

_WSS_PATH = "/v1/listen"      # update if CronTech uses a different path
_HEALTH_PATH = "/v1/health"   # update with actual CronTech health endpoint

_PARAMS = {
    "model":           "crontech-voice-1",   # CronTech model name (update when known)
    "smart_format":    "true",
    "punctuate":       "true",
    "interim_results": "true",
    "endpointing":     "300",
}


class CronTechProvider(VoiceProvider):
    @property
    def name(self) -> str:
        return "crontech"

    def _base_url(self) -> str:
        s = get_settings()
        url = s.crontech_voice_url or s.crontech_api_url
        if not url:
            raise RuntimeError(
                "Set CRONTECH_VOICE_URL (or CRONTECH_API_URL) to use CronTech voice."
            )
        return url.rstrip("/")

    def get_config(self) -> VoiceConfig:
        s = get_settings()
        key = s.crontech_api_key
        if not key:
            raise RuntimeError("CRONTECH_API_KEY is not set.")

        base = self._base_url()
        # Convert http(s) base URL to wss
        wss_base = base.replace("https://", "wss://").replace("http://", "ws://")
        qs = "&".join(f"{k}={v}" for k, v in _PARAMS.items())

        return VoiceConfig(
            provider="crontech",
            ws_url=f"{wss_base}{_WSS_PATH}?{qs}",
            auth_token=key,
            model="crontech-voice-1",
            features={"filler_words": True, "endpointing_ms": 300, "native": True},
        )

    def health_check(self) -> dict:
        s = get_settings()
        if not s.crontech_api_key:
            return {"ok": False, "latency_ms": None, "detail": "CRONTECH_API_KEY not set"}
        try:
            base = self._base_url()
        except RuntimeError as exc:
            return {"ok": False, "latency_ms": None, "detail": str(exc)}

        t0 = time.monotonic()
        try:
            resp = httpx.get(
                f"{base}{_HEALTH_PATH}",
                headers={"Authorization": f"Bearer {s.crontech_api_key}"},
                timeout=5,
            )
            latency = int((time.monotonic() - t0) * 1000)
            if resp.status_code < 400:
                return {"ok": True, "latency_ms": latency, "detail": "ok"}
            return {"ok": False, "latency_ms": latency, "detail": f"HTTP {resp.status_code}"}
        except Exception as exc:
            return {"ok": False, "latency_ms": None, "detail": str(exc)}
