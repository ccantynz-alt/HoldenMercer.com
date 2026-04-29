"""
Resiliency wrapper for the Anthropic API.

Behaviour:
  - Retries on 529 (overloaded) and 429 (rate-limit) up to MAX_RETRIES times
    with exponential back-off and full jitter.
  - Falls over to AWS Bedrock automatically if Anthropic exhausts all retries
    or returns a non-recoverable 5xx.
  - Exposes a single `resilient_create()` coroutine that mirrors the
    anthropic.messages.create() signature so callers need zero changes.
"""

from __future__ import annotations

import json
import logging
import random
import time
from typing import Any

import anthropic
from tenacity import (
    Retrying,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential_jitter,
    before_sleep_log,
    RetryError,
)

from core.config import get_settings

logger = logging.getLogger(__name__)

_settings = get_settings()

# ---------------------------------------------------------------------------
# Retry predicate
# ---------------------------------------------------------------------------

_RETRYABLE_STATUS = {429, 529}


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, anthropic.RateLimitError):
        return True
    if isinstance(exc, anthropic.APIStatusError):
        return exc.status_code in _RETRYABLE_STATUS
    # Network / timeout errors are always retryable
    if isinstance(exc, (anthropic.APIConnectionError, anthropic.APITimeoutError)):
        return True
    return False


# ---------------------------------------------------------------------------
# Anthropic client (lazy singleton)
# ---------------------------------------------------------------------------

_anthropic_client: anthropic.Anthropic | None = None


def _get_anthropic() -> anthropic.Anthropic:
    global _anthropic_client
    if _anthropic_client is None:
        _anthropic_client = anthropic.Anthropic(
            api_key=_settings.anthropic_api_key,
            timeout=_settings.request_timeout,
            max_retries=0,  # We manage retries ourselves via tenacity
        )
    return _anthropic_client


# ---------------------------------------------------------------------------
# Bedrock failover client (lazy singleton)
# ---------------------------------------------------------------------------

_bedrock_client: Any | None = None


def _get_bedrock():
    global _bedrock_client
    if _bedrock_client is None:
        # Lazy import — boto3 is heavyweight (~50 MB) and only needed when
        # Anthropic exhausts retries. Vercel's slim function bundle omits it.
        try:
            import boto3
        except ImportError as exc:
            raise RuntimeError(
                "Bedrock failover unavailable in this deploy — boto3 is not "
                "installed. Run on a host with the full requirements.txt or "
                "let Anthropic retries handle the request."
            ) from exc
        _bedrock_client = boto3.client(
            service_name="bedrock-runtime",
            region_name=_settings.aws_region,
            aws_access_key_id=_settings.aws_access_key_id or None,
            aws_secret_access_key=_settings.aws_secret_access_key or None,
        )
    return _bedrock_client


# ---------------------------------------------------------------------------
# Bedrock call — translates Anthropic kwargs to Bedrock InvokeModel format
# ---------------------------------------------------------------------------

def _call_bedrock(model: str, messages: list[dict], **kwargs) -> dict:
    """
    Calls AWS Bedrock using the Anthropic Messages API payload format.
    Returns a dict that mirrors anthropic.types.Message for easy consumption.

    Strips Anthropic-only params that Bedrock does not support:
      - ``thinking``     — extended thinking budget (Opus 4.7+)
      - ``cache_control`` blocks inside the system list
    """
    bedrock = _get_bedrock()

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "messages": messages,
        "max_tokens": kwargs.get("max_tokens", 4096),
    }

    # Flatten system: accept either a plain string or a list of text blocks
    # (prompt-caching format). Strip cache_control — Bedrock ignores it but
    # some versions reject unknown fields.
    if "system" in kwargs:
        sys = kwargs["system"]
        if isinstance(sys, list):
            sys = "\n\n".join(
                b.get("text", "") if isinstance(b, dict) else getattr(b, "text", "")
                for b in sys
            ).strip()
        body["system"] = sys

    if "temperature" in kwargs:
        body["temperature"] = kwargs["temperature"]
    if "top_p" in kwargs:
        body["top_p"] = kwargs["top_p"]
    # Intentionally skip: thinking, stream — not supported by Bedrock

    bedrock_model = _settings.bedrock_model_id
    logger.info("Bedrock failover: invoking model=%s", bedrock_model)

    response = bedrock.invoke_model(
        modelId=bedrock_model,
        body=json.dumps(body),
        contentType="application/json",
        accept="application/json",
    )
    payload = json.loads(response["body"].read())
    return payload


# ---------------------------------------------------------------------------
# Tenacity-wrapped Anthropic call
# ---------------------------------------------------------------------------

def _anthropic_with_retries(model: str, messages: list[dict], **kwargs) -> Any:
    # Build retry policy at call time so test overrides of _settings take effect.
    for attempt in Retrying(
        retry=retry_if_exception(_is_retryable),
        stop=stop_after_attempt(_settings.max_retries),
        wait=wait_exponential_jitter(
            initial=_settings.base_retry_delay,
            max=_settings.max_retry_delay,
            jitter=2.0,
        ),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    ):
        with attempt:
            logger.debug("Anthropic request: model=%s", model)
            return _get_anthropic().messages.create(model=model, messages=messages, **kwargs)


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

def resilient_create(
    model: str,
    messages: list[dict],
    *,
    use_bedrock_fallback: bool = True,
    **kwargs,
) -> Any:
    """
    Drop-in replacement for ``anthropic.Anthropic().messages.create()``.

    Retries transient Anthropic errors (429/529/network) up to
    ``settings.max_retries`` times with exponential back-off + jitter.
    If all retries are exhausted, falls over to AWS Bedrock when
    ``use_bedrock_fallback=True``.

    Returns either an ``anthropic.types.Message`` or a Bedrock response dict.
    """
    try:
        return _anthropic_with_retries(model=model, messages=messages, **kwargs)
    except RetryError as exc:
        last = exc.last_attempt.exception()
        logger.error(
            "Anthropic exhausted %d retries (%s). Triggering Bedrock failover.",
            _settings.max_retries,
            type(last).__name__,
        )
        if use_bedrock_fallback:
            return _call_bedrock(model=model, messages=messages, **kwargs)
        raise last from exc
    except anthropic.APIStatusError as exc:
        if exc.status_code >= 500 and use_bedrock_fallback:
            logger.error(
                "Anthropic %d error. Triggering Bedrock failover.", exc.status_code
            )
            return _call_bedrock(model=model, messages=messages, **kwargs)
        raise


# ---------------------------------------------------------------------------
# Health-check helper used by tests and startup probes
# ---------------------------------------------------------------------------

def check_anthropic_health() -> dict:
    """Returns {ok: bool, latency_ms: float, error: str|None}."""
    start = time.monotonic()
    try:
        resp = resilient_create(
            model="claude-haiku-4-5-20251001",
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=5,
            use_bedrock_fallback=False,
        )
        latency = (time.monotonic() - start) * 1000
        return {"ok": True, "latency_ms": round(latency, 1), "error": None}
    except Exception as exc:  # noqa: BLE001
        latency = (time.monotonic() - start) * 1000
        return {"ok": False, "latency_ms": round(latency, 1), "error": str(exc)}
