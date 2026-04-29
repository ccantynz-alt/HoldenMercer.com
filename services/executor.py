"""
Execution Bridge — turns a refined technical intent into Claude action.

Two modes:
  • Immediate  — simple/medium tasks: synchronous agentic loop via resilient_create().
  • Batch      — large/overnight tasks: Anthropic Message Batches API at ~50% cost.
                 Returns immediately with a batch_id; results polled separately.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

import anthropic

from core.config import get_settings
from core.resiliency import _get_anthropic

logger = logging.getLogger(__name__)

_settings = get_settings()

SONNET_MODEL = "claude-sonnet-4-6"

_EXECUTION_SYSTEM = """\
You are an expert software engineer with full access to the project context.
Execute the following technical requirement precisely. Think step-by-step.
Output only the result — code, commands, or a structured plan — with no preamble."""


# ---------------------------------------------------------------------------
# Immediate execution
# ---------------------------------------------------------------------------

def execute_immediate(refined_text: str, mcp_refs: list[str]) -> dict:
    """
    Run a single-turn agentic execution synchronously.
    Returns {status, result_text, model, input_tokens, output_tokens}.
    """
    from core.resiliency import resilient_create

    context = ""
    if mcp_refs:
        context = f"\nFiles / repos in scope: {', '.join(mcp_refs)}\n"

    response = resilient_create(
        model=SONNET_MODEL,
        messages=[{"role": "user", "content": f"{context}{refined_text}"}],
        system=_EXECUTION_SYSTEM,
        max_tokens=4096,
    )

    if hasattr(response, "content"):
        result_text = response.content[0].text
        usage = response.usage
        return {
            "status": "completed",
            "result_text": result_text,
            "model": SONNET_MODEL,
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
        }
    # Bedrock fallback dict
    return {
        "status": "completed_via_bedrock",
        "result_text": response["content"][0]["text"],
        "model": _settings.bedrock_model_id,
        "input_tokens": response.get("usage", {}).get("input_tokens", 0),
        "output_tokens": response.get("usage", {}).get("output_tokens", 0),
    }


# ---------------------------------------------------------------------------
# Batch execution (overnight / large tasks)
# ---------------------------------------------------------------------------

def execute_batch(
    refined_text: str,
    session_id: str,
    mcp_refs: list[str],
) -> dict:
    """
    Submit a task to the Anthropic Message Batches API.
    Returns immediately with {status: "queued", batch_id, custom_id}.
    The caller should store batch_id in the session row for later polling.
    """
    client = _get_anthropic()

    context = ""
    if mcp_refs:
        context = f"\nFiles / repos in scope: {', '.join(mcp_refs)}\n"

    custom_id = f"sovereign-{session_id}"

    batch = client.messages.batches.create(
        requests=[
            {
                "custom_id": custom_id,
                "params": {
                    "model": SONNET_MODEL,
                    "max_tokens": 8192,
                    "system": _EXECUTION_SYSTEM,
                    "messages": [
                        {"role": "user", "content": f"{context}{refined_text}"}
                    ],
                },
            }
        ]
    )

    logger.info("Batch submitted: id=%s custom_id=%s", batch.id, custom_id)
    return {
        "status": "queued",
        "batch_id": batch.id,
        "custom_id": custom_id,
        "processing_status": batch.processing_status,
    }


def poll_batch_result(batch_id: str, custom_id: str) -> dict | None:
    """
    Poll a submitted batch for a specific custom_id result.
    Returns the result dict when ready, or None if still processing.
    """
    client = _get_anthropic()
    batch = client.messages.batches.retrieve(batch_id)

    if batch.processing_status != "ended":
        return None

    for result in client.messages.batches.results(batch_id):
        if result.custom_id == custom_id:
            if result.result.type == "succeeded":
                msg = result.result.message
                return {
                    "status": "completed",
                    "result_text": msg.content[0].text,
                    "model": msg.model,
                    "input_tokens": msg.usage.input_tokens,
                    "output_tokens": msg.usage.output_tokens,
                }
            return {
                "status": "failed",
                "error": str(result.result),
            }
    return None


# ---------------------------------------------------------------------------
# Router — decides immediate vs batch
# ---------------------------------------------------------------------------

def dispatch(
    refined_text: str,
    session_id: str,
    task_complexity: str,
    mcp_refs: list[str],
) -> dict:
    """
    Route to immediate or batch execution based on task_complexity.
    Returns the execution result dict (immediate) or a queued receipt (batch).
    """
    if task_complexity == "large":
        logger.info("session=%s dispatching to Batch API (large task)", session_id)
        return execute_batch(refined_text, session_id, mcp_refs)

    logger.info("session=%s dispatching to immediate execution (%s)", session_id, task_complexity)
    return execute_immediate(refined_text, mcp_refs)
