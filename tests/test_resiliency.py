"""
Tests for core/resiliency.py.
All network calls are mocked — no real API keys required.
"""

import json
import unittest
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, call

import anthropic
import pytest

# Patch settings before importing resiliency so the module picks up test values
import core.config as _cfg

_cfg.get_settings.cache_clear()
_test_settings = _cfg.Settings(
    anthropic_api_key="test-key",
    max_retries=3,
    base_retry_delay=0.01,
    max_retry_delay=0.1,
)
with patch("core.config.get_settings", return_value=_test_settings):
    import core.resiliency as res

# Patch module-level _settings reference used inside resiliency
res._settings = _test_settings


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_anthropic_message(content: str = "ok") -> anthropic.types.Message:
    return anthropic.types.Message(
        id="msg_test",
        content=[anthropic.types.TextBlock(type="text", text=content)],
        model="claude-haiku-4-5-20251001",
        role="assistant",
        stop_reason="end_turn",
        stop_sequence=None,
        type="message",
        usage=anthropic.types.Usage(input_tokens=1, output_tokens=1),
    )


def _make_bedrock_response(content: str = "bedrock-ok") -> dict:
    return {
        "id": "msg_bedrock",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": content}],
        "model": "anthropic.claude-sonnet-4-5",
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }


MESSAGES = [{"role": "user", "content": "hello"}]


# ---------------------------------------------------------------------------
# 1. Happy path — Anthropic responds on first try
# ---------------------------------------------------------------------------

def test_success_on_first_attempt():
    mock_response = _make_anthropic_message("hello back")
    with patch.object(res, "_get_anthropic") as mock_factory:
        mock_client = MagicMock()
        mock_client.messages.create.return_value = mock_response
        mock_factory.return_value = mock_client
        res._anthropic_client = None

        result = res.resilient_create(
            model="claude-haiku-4-5-20251001",
            messages=MESSAGES,
            max_tokens=10,
        )

    assert result.content[0].text == "hello back"
    mock_client.messages.create.assert_called_once()


# ---------------------------------------------------------------------------
# 2. Retries on 429 then succeeds
# ---------------------------------------------------------------------------

def test_retries_on_rate_limit_then_succeeds():
    rate_limit_exc = anthropic.RateLimitError(
        message="rate limited",
        response=MagicMock(status_code=429, headers={}),
        body={},
    )
    mock_response = _make_anthropic_message("eventually ok")

    with patch.object(res, "_get_anthropic") as mock_factory:
        mock_client = MagicMock()
        mock_client.messages.create.side_effect = [
            rate_limit_exc,
            rate_limit_exc,
            mock_response,
        ]
        mock_factory.return_value = mock_client
        res._anthropic_client = None

        result = res.resilient_create(
            model="claude-haiku-4-5-20251001",
            messages=MESSAGES,
            max_tokens=10,
        )

    assert result.content[0].text == "eventually ok"
    assert mock_client.messages.create.call_count == 3


# ---------------------------------------------------------------------------
# 3. Retries on 529 (overloaded) then fails over to Bedrock
# ---------------------------------------------------------------------------

def test_bedrock_failover_after_exhausted_retries():
    overloaded_exc = anthropic.APIStatusError(
        message="overloaded",
        response=MagicMock(status_code=529, headers={}),
        body={},
    )
    bedrock_resp = _make_bedrock_response("bedrock saved me")

    with (
        patch.object(res, "_get_anthropic") as mock_factory,
        patch.object(res, "_call_bedrock", return_value=bedrock_resp) as mock_bedrock,
    ):
        mock_client = MagicMock()
        mock_client.messages.create.side_effect = overloaded_exc
        mock_factory.return_value = mock_client
        res._anthropic_client = None

        result = res.resilient_create(
            model="claude-haiku-4-5-20251001",
            messages=MESSAGES,
            max_tokens=10,
        )

    assert result["content"][0]["text"] == "bedrock saved me"
    mock_bedrock.assert_called_once()
    assert mock_client.messages.create.call_count == _test_settings.max_retries


# ---------------------------------------------------------------------------
# 4. Non-retryable 4xx is raised immediately (no retries, no Bedrock)
# ---------------------------------------------------------------------------

def test_non_retryable_error_raises_immediately():
    auth_exc = anthropic.AuthenticationError(
        message="bad key",
        response=MagicMock(status_code=401, headers={}),
        body={},
    )
    with patch.object(res, "_get_anthropic") as mock_factory:
        mock_client = MagicMock()
        mock_client.messages.create.side_effect = auth_exc
        mock_factory.return_value = mock_client
        res._anthropic_client = None

        with pytest.raises(anthropic.AuthenticationError):
            res.resilient_create(
                model="claude-haiku-4-5-20251001",
                messages=MESSAGES,
                max_tokens=10,
                use_bedrock_fallback=False,
            )

    assert mock_client.messages.create.call_count == 1


# ---------------------------------------------------------------------------
# 5. 500 server error immediately triggers Bedrock (no retry loop)
# ---------------------------------------------------------------------------

def test_500_triggers_bedrock_immediately():
    server_exc = anthropic.APIStatusError(
        message="internal server error",
        response=MagicMock(status_code=500, headers={}),
        body={},
    )
    bedrock_resp = _make_bedrock_response("bedrock fallback")

    with (
        patch.object(res, "_get_anthropic") as mock_factory,
        patch.object(res, "_call_bedrock", return_value=bedrock_resp) as mock_bedrock,
    ):
        mock_client = MagicMock()
        mock_client.messages.create.side_effect = server_exc
        mock_factory.return_value = mock_client
        res._anthropic_client = None

        result = res.resilient_create(
            model="claude-haiku-4-5-20251001",
            messages=MESSAGES,
            max_tokens=10,
        )

    assert result["content"][0]["text"] == "bedrock fallback"
    mock_bedrock.assert_called_once()


# ---------------------------------------------------------------------------
# 6. _is_retryable classification
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("status,expected", [
    (429, True),
    (529, True),
    (500, False),
    (400, False),
    (401, False),
])
def test_is_retryable_status_codes(status, expected):
    exc = anthropic.APIStatusError(
        message="test",
        response=MagicMock(status_code=status, headers={}),
        body={},
    )
    assert res._is_retryable(exc) is expected


def test_is_retryable_rate_limit_error():
    exc = anthropic.RateLimitError(
        message="rate limited",
        response=MagicMock(status_code=429, headers={}),
        body={},
    )
    assert res._is_retryable(exc) is True


def test_is_retryable_connection_error():
    exc = anthropic.APIConnectionError(request=MagicMock())
    assert res._is_retryable(exc) is True


def test_is_retryable_timeout():
    exc = anthropic.APITimeoutError(request=MagicMock())
    assert res._is_retryable(exc) is True


# ---------------------------------------------------------------------------
# 7. check_anthropic_health helper
# ---------------------------------------------------------------------------

def test_health_check_ok():
    mock_response = _make_anthropic_message("pong")
    with patch.object(res, "resilient_create", return_value=mock_response):
        result = res.check_anthropic_health()
    assert result["ok"] is True
    assert result["error"] is None
    assert isinstance(result["latency_ms"], float)


def test_health_check_failure():
    with patch.object(res, "resilient_create", side_effect=Exception("network down")):
        result = res.check_anthropic_health()
    assert result["ok"] is False
    assert "network down" in result["error"]
