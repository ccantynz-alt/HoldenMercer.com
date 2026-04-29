"""
Provider factory — returns the active VoiceProvider based on INFRA_MODE.

Switch logic:
  1. INFRA_MODE=CRONTECH  →  CronTechProvider (explicit)
  2. crontech_api_key set →  CronTechProvider (auto-promote)
  3. fallback             →  DeepgramProvider

Single env-var flip:  INFRA_MODE=CRONTECH
"""

from __future__ import annotations

from functools import lru_cache

from api.providers.base import VoiceProvider


@lru_cache(maxsize=1)
def get_voice_provider() -> VoiceProvider:
    from core.config import get_settings
    s = get_settings()

    # Explicit override takes precedence
    mode = s.infra_mode.upper()

    # Auto-promote: CronTech creds present → use CronTech
    if mode != "DEEPGRAM" and not s.crontech_api_key:
        mode = "DEEPGRAM"
    if s.crontech_api_key and mode == "DEEPGRAM" and s.crontech_enabled:
        mode = "CRONTECH"

    if mode == "CRONTECH":
        from api.providers.crontech import CronTechProvider
        return CronTechProvider()

    from api.providers.deepgram import DeepgramProvider
    return DeepgramProvider()
