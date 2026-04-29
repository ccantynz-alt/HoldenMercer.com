"""
Tests for api/gateway.py — all external calls (Anthropic, Supabase) are mocked.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)

INGEST_URL = "/api/voxlen-ingest"

MINIMAL_PAYLOAD = {
    "session_id": "test-session-001",
    "raw_text": "um build me a, uh, FastAPI endpoint for user auth",
}

FULL_PAYLOAD = {
    "session_id": "test-session-002",
    "user_id": "user@voxlen.ai",
    "raw_text": "execute, um, refactor the resiliency dot py file to add streaming support",
    "timestamp": "2026-04-28T14:00:00Z",
    "execute": False,
    "metadata": {
        "source": "voxlen_dictation",
        "language": "en",
        "confidence": 0.91,
        "duration_seconds": 8.2,
    },
}


def _mock_refiner_result(keyword="build", complexity="simple"):
    return {
        "refined_text": "Build a FastAPI endpoint for user authentication.",
        "intent": "Create a user auth endpoint.",
        "mcp_refs": [],
        "execution_keyword": keyword,
        "task_complexity": complexity,
    }


def _mock_exec_result():
    return {
        "status": "completed",
        "result_text": "Here is the FastAPI endpoint...",
        "model": "claude-sonnet-4-6",
        "input_tokens": 100,
        "output_tokens": 200,
    }


# ---------------------------------------------------------------------------
# 1. Minimal payload — no Supabase, no execution
# ---------------------------------------------------------------------------

def test_ingest_minimal_no_supabase_no_exec():
    refiner_result = {
        **_mock_refiner_result(keyword=None),
        "execution_keyword": None,
    }
    with (
        patch("api.gateway._in_thread", side_effect=_mock_in_thread(refiner_result)),
    ):
        resp = client.post(INGEST_URL, json=MINIMAL_PAYLOAD)

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["session_id"] == "test-session-001"
    assert body["execution"] is None


def _mock_in_thread(refiner_result):
    """Returns an async side_effect that returns memory_row for store_session, refiner_result for refine."""
    call_count = [0]

    async def side_effect(fn, *args, **kwargs):
        call_count[0] += 1
        name = getattr(fn, "__name__", str(fn))
        if name == "store_session":
            return {"id": "mock-uuid-001"}
        if name == "refine":
            return refiner_result
        if name == "update_session":
            return {}
        if name == "dispatch":
            return _mock_exec_result()
        if name == "get_recent_sessions":
            return []
        return {}

    return side_effect


# ---------------------------------------------------------------------------
# 2. Full payload — execution triggered by keyword
# ---------------------------------------------------------------------------

def test_ingest_execution_triggered_by_keyword():
    with patch("api.gateway._in_thread", side_effect=_mock_in_thread(_mock_refiner_result("build", "simple"))):
        resp = client.post(INGEST_URL, json=FULL_PAYLOAD)

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["execution_keyword"] == "build"
    assert body["execution"]["status"] == "completed"
    assert body["execution"]["result_text"] is not None


# ---------------------------------------------------------------------------
# 3. Large task → batch queued
# ---------------------------------------------------------------------------

def test_ingest_large_task_batch_queued():
    batch_exec = {
        "status": "queued",
        "batch_id": "msgbatch_abc123",
        "custom_id": "sovereign-test-session-003",
        "processing_status": "in_progress",
    }

    async def side_effect(fn, *args, **kwargs):
        name = getattr(fn, "__name__", str(fn))
        if name == "store_session":
            return {"id": "mock-uuid-003"}
        if name == "refine":
            return _mock_refiner_result("build", "large")
        if name == "dispatch":
            return batch_exec
        return {}

    with patch("api.gateway._in_thread", side_effect=side_effect):
        resp = client.post(INGEST_URL, json={**MINIMAL_PAYLOAD, "session_id": "test-session-003"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["task_complexity"] == "large"
    assert body["execution"]["status"] == "queued"
    assert body["execution"]["batch_id"] == "msgbatch_abc123"


# ---------------------------------------------------------------------------
# 4. Supabase unavailable → warning, pipeline continues
# ---------------------------------------------------------------------------

def test_ingest_supabase_unavailable():
    import services.memory as mem_mod

    async def side_effect(fn, *args, **kwargs):
        name = getattr(fn, "__name__", str(fn))
        if name == "store_session":
            raise RuntimeError("SUPABASE_URL and SUPABASE_KEY must be set")
        if name == "refine":
            return {**_mock_refiner_result(keyword=None), "execution_keyword": None}
        return {}

    with patch("api.gateway._in_thread", side_effect=side_effect):
        resp = client.post(INGEST_URL, json=MINIMAL_PAYLOAD)

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert any("Project Memory unavailable" in w for w in body["warnings"])
    assert body["memory_id"] is None


# ---------------------------------------------------------------------------
# 5. Anthropic 529 during refinement → warning, raw text returned
# ---------------------------------------------------------------------------

def test_ingest_529_during_refinement():
    import anthropic as ant

    async def side_effect(fn, *args, **kwargs):
        name = getattr(fn, "__name__", str(fn))
        if name == "store_session":
            return {"id": "mock-uuid-529"}
        if name == "refine":
            raise ant.APIStatusError(
                message="overloaded",
                response=MagicMock(status_code=529, headers={}),
                body={},
            )
        return {}

    with patch("api.gateway._in_thread", side_effect=side_effect):
        resp = client.post(INGEST_URL, json=MINIMAL_PAYLOAD)

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    # Raw text used as fallback
    assert body["refined_text"] == MINIMAL_PAYLOAD["raw_text"]
    assert any("529" in w for w in body["warnings"])


# ---------------------------------------------------------------------------
# 6. force-execute flag overrides missing keyword
# ---------------------------------------------------------------------------

def test_ingest_force_execute_flag():
    no_keyword_refine = {**_mock_refiner_result(keyword=None), "execution_keyword": None}

    async def side_effect(fn, *args, **kwargs):
        name = getattr(fn, "__name__", str(fn))
        if name == "store_session":
            return {"id": "mock-uuid-force"}
        if name == "refine":
            return no_keyword_refine
        if name == "dispatch":
            return _mock_exec_result()
        return {}

    payload = {**MINIMAL_PAYLOAD, "execute": True, "session_id": "test-session-force"}
    with patch("api.gateway._in_thread", side_effect=side_effect):
        resp = client.post(INGEST_URL, json=payload)

    assert resp.status_code == 200
    body = resp.json()
    assert body["execution"]["status"] == "completed"


# ---------------------------------------------------------------------------
# 7. /health endpoint returns ok
# ---------------------------------------------------------------------------

def test_health_endpoint():
    with patch("core.resiliency.check_anthropic_health", return_value={"ok": True, "latency_ms": 42.0, "error": None}):
        resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["sovereign_engine"] == "ok"
