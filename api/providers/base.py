"""Abstract VoiceProvider — every provider must implement this interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class VoiceConfig:
    """Serialisable config sent to the frontend so it knows where to connect."""
    provider: str          # "deepgram" | "crontech"
    ws_url: str            # full WSS URL including query params
    auth_token: str        # token for WebSocket subprotocol auth
    model: str             # model name for display
    features: dict         # provider-specific capability flags


class VoiceProvider(ABC):
    """
    Interface every voice backend must satisfy.

    The frontend calls GET /api/voice/config to receive a VoiceConfig,
    then opens:  new WebSocket(ws_url, ['token', auth_token])
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable provider name."""

    @abstractmethod
    def get_config(self) -> VoiceConfig:
        """Return the WebSocket connection details for the frontend."""

    @abstractmethod
    def health_check(self) -> dict:
        """
        Ping the provider and return latency + status.
        Must return: {ok: bool, latency_ms: int | None, detail: str}
        """
