"""
Tests for api/dictation_polish.py — Haiku is mocked.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)

POLISH_URL = "/api/dictation/polish"


def _mock_haiku_response(text: str) -> MagicMock:
    """Match the .content[0].text shape of an Anthropic Message."""
    msg = MagicMock()
    msg.content = [MagicMock(text=text)]
    return msg


@patch("api.dictation_polish.resilient_create")
def test_polish_returns_polished_prose(mock_create):
    mock_create.return_value = _mock_haiku_response(
        "Build a FastAPI endpoint for user authentication."
    )

    res = client.post(POLISH_URL, json={
        "text": "um build me a uh FastAPI endpoint for user auth",
        "style": "professional",
        "session_id": "s-1",
    })

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["style"] == "professional"
    assert data["polished"] == "Build a FastAPI endpoint for user authentication."
    assert data["word_count_in"]  > 0
    assert data["word_count_out"] > 0
    assert data["session_id"] == "s-1"


@patch("api.dictation_polish.resilient_create")
@pytest.mark.parametrize("style", ["professional", "casual", "academic", "creative", "technical"])
def test_polish_supports_all_styles(mock_create, style):
    mock_create.return_value = _mock_haiku_response("Polished text.")
    res = client.post(POLISH_URL, json={
        "text": "raw text",
        "style": style,
        "session_id": "s-style",
    })
    assert res.status_code == 200
    assert res.json()["style"] == style


def test_polish_rejects_invalid_style():
    res = client.post(POLISH_URL, json={
        "text": "raw",
        "style": "shakespearean",   # not in the Literal whitelist
        "session_id": "s-bad",
    })
    assert res.status_code == 422


def test_polish_rejects_empty_text():
    res = client.post(POLISH_URL, json={
        "text": "",
        "style": "professional",
        "session_id": "s-empty",
    })
    assert res.status_code == 422


@patch("api.dictation_polish.resilient_create")
def test_polish_falls_back_to_raw_on_overload(mock_create):
    """529 from Haiku should fall through and return the raw text unchanged."""
    import anthropic
    err = anthropic.APIStatusError(
        "overloaded",
        response=MagicMock(status_code=529),
        body={"error": {"type": "overloaded"}},
    )
    err.status_code = 529
    mock_create.side_effect = err

    res = client.post(POLISH_URL, json={
        "text": "the original raw dictation",
        "style": "professional",
        "session_id": "s-overload",
    })
    assert res.status_code == 200
    assert res.json()["polished"] == "the original raw dictation"
