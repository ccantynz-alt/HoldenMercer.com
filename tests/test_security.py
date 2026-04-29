"""
Tests for core/security.py and the API key guard on /api/voxlen-ingest.
"""

from __future__ import annotations

from unittest.mock import patch, AsyncMock

import pytest
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app, raise_server_exceptions=False)

INGEST_URL = "/api/voxlen-ingest"

PAYLOAD = {
    "session_id": "sec-test-001",
    "raw_text": "build a login page",
}

# Refiner stub — returns a no-keyword result so execution is skipped
_REFINE_STUB = {
    "refined_text": "Build a login page.",
    "intent": "Create login UI.",
    "mcp_refs": [],
    "execution_keyword": None,
    "task_complexity": "simple",
}


async def _passthrough_in_thread(fn, *args, **kwargs):
    name = getattr(fn, "__name__", "")
    if name == "store_session":
        return {"id": "mock-uuid"}
    if name == "refine":
        return _REFINE_STUB
    if name == "update_session":
        return {}
    if name == "get_recent_sessions":
        return []
    return {}


# ── Helper: override sovereign_api_key for a test ───────────────────────────

def _patched_settings(key: str):
    """Returns a context-manager that sets sovereign_api_key on the cached settings."""
    from core.config import get_settings
    settings = get_settings()
    original = settings.sovereign_api_key

    class _Ctx:
        def __enter__(self):
            object.__setattr__(settings, "sovereign_api_key", key)
            return settings
        def __exit__(self, *_):
            object.__setattr__(settings, "sovereign_api_key", original)

    return _Ctx()


# ── 1. No key configured → dev-mode, request passes ────────────────────────

def test_no_key_configured_passes():
    with (
        _patched_settings(""),
        patch("api.gateway._in_thread", side_effect=_passthrough_in_thread),
    ):
        resp = client.post(INGEST_URL, json=PAYLOAD)

    assert resp.status_code == 200
    assert resp.json()["ok"] is True


# ── 2. Key set + correct header → 200 ───────────────────────────────────────

def test_correct_key_passes():
    with (
        _patched_settings("super-secret-key-abc"),
        patch("api.gateway._in_thread", side_effect=_passthrough_in_thread),
    ):
        resp = client.post(
            INGEST_URL,
            json=PAYLOAD,
            headers={"X-Sovereign-Key": "super-secret-key-abc"},
        )

    assert resp.status_code == 200
    assert resp.json()["ok"] is True


# ── 3. Key set + wrong header → 401 ─────────────────────────────────────────

def test_wrong_key_rejected():
    with _patched_settings("super-secret-key-abc"):
        resp = client.post(
            INGEST_URL,
            json=PAYLOAD,
            headers={"X-Sovereign-Key": "wrong-key"},
        )

    assert resp.status_code == 401
    assert "Invalid or missing" in resp.json()["detail"]


# ── 4. Key set + header absent → 401 ────────────────────────────────────────

def test_missing_header_rejected():
    with _patched_settings("super-secret-key-abc"):
        resp = client.post(INGEST_URL, json=PAYLOAD)

    assert resp.status_code == 401


# ── 5. /health is never gated ───────────────────────────────────────────────

def test_health_always_open():
    with (
        _patched_settings("super-secret-key-abc"),
        patch("core.resiliency.check_anthropic_health", return_value={"ok": True, "latency_ms": 1.0, "error": None}),
    ):
        resp = client.get("/health")

    assert resp.status_code == 200
    assert resp.json()["sovereign_engine"] == "ok"


# ── 6. timing-safe comparison — different lengths don't short-circuit ────────

def test_timing_safe_rejects_prefix():
    with _patched_settings("super-secret-key-abc"):
        resp = client.post(
            INGEST_URL,
            json=PAYLOAD,
            headers={"X-Sovereign-Key": "super-secret"},   # correct prefix, wrong key
        )
    assert resp.status_code == 401
