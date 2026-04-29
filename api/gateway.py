"""
Sovereign Engine — Voxlen Ingestion Gateway
POST /api/voxlen-ingest

Full pipeline per request:
  1. Validate & immediately persist raw payload to Supabase Project Memory.
  2. Run Haiku 4.5 Refiner to clean dictation → structured intent.
  3. Patch Supabase row with refined data.
  4. If intent starts with an execution keyword → Execution Bridge.
     - task_complexity == "large"  → Batch API (overnight, 50% cost).
     - task_complexity != "large"  → immediate agentic execution.
  5. Return full pipeline result to Voxlen frontend in one response.
     Any 529 events are surfaced in ``warnings[]`` but never stop the pipeline.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

import anthropic
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from core.config import get_settings
from core.security import require_api_key

logger = logging.getLogger(__name__)
_settings = get_settings()

router = APIRouter(prefix="/api", tags=["voxlen"])


# ---------------------------------------------------------------------------
# Request / Response models  (these ARE the contract Voxlen.ai must follow)
# ---------------------------------------------------------------------------

class VoxlenMetadata(BaseModel):
    source: str = "voxlen_dictation"
    language: str = "en"
    confidence: float | None = None
    duration_seconds: float | None = None
    # Any extra k/v your site wants to forward — stored as-is
    extra: dict[str, Any] = Field(default_factory=dict)


class VoxlenIngestRequest(BaseModel):
    """
    ┌─────────────────────────────────────────────────────────────────────┐
    │  JSON CONTRACT — what Voxlen.ai must POST to /api/voxlen-ingest     │
    └─────────────────────────────────────────────────────────────────────┘

    Required fields
    ───────────────
    session_id  : string  — unique ID per recording/utterance (UUID recommended)
    raw_text    : string  — the raw speech-to-text output from Voxlen

    Optional fields
    ───────────────
    user_id     : string  — your user identifier (email or UUID)
    timestamp   : string  — ISO-8601 UTC (default: server time if omitted)
    execute     : bool    — force execution bridge even without keyword (default false)
    metadata    : object  — see VoxlenMetadata above

    Example
    ───────
    {
      "session_id": "d4f2a1b0-9c3e-4f7a-8e1d-2b5c6a0f3e9d",
      "user_id": "ccantynz@gmail.com",
      "raw_text": "um execute uh build me a, like, FastAPI endpoint for user authentication",
      "timestamp": "2026-04-28T14:30:00Z",
      "execute": false,
      "metadata": {
        "source": "voxlen_dictation",
        "language": "en",
        "confidence": 0.91,
        "duration_seconds": 8.2
      }
    }
    """

    session_id: str = Field(
        ...,
        description="Unique ID per utterance. Use UUID v4.",
        examples=["d4f2a1b0-9c3e-4f7a-8e1d-2b5c6a0f3e9d"],
    )
    raw_text: str = Field(
        ...,
        min_length=1,
        description="Raw speech-to-text from Voxlen — can be messy.",
    )
    user_id: str | None = Field(None, description="Your user identifier.")
    timestamp: str | None = Field(
        None,
        description="ISO-8601 UTC timestamp. Defaults to server time.",
    )
    execute: bool = Field(
        False,
        description="Force execution bridge even if no keyword detected.",
    )
    metadata: VoxlenMetadata = Field(default_factory=VoxlenMetadata)


class ExecutionResult(BaseModel):
    status: str
    result_text: str | None = None
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    batch_id: str | None = None
    custom_id: str | None = None


class VoxlenIngestResponse(BaseModel):
    ok: bool
    session_id: str
    memory_id: str | None = None          # Supabase row UUID
    refined_text: str
    intent: str
    mcp_refs: list[str]
    execution_keyword: str | None
    task_complexity: str
    execution: ExecutionResult | None = None
    warnings: list[str] = Field(default_factory=list)
    processing_ms: float


# ---------------------------------------------------------------------------
# Helper: run blocking I/O off the event loop
# ---------------------------------------------------------------------------

async def _in_thread(fn, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: fn(*args, **kwargs))


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post(
    "/voxlen-ingest",
    response_model=VoxlenIngestResponse,
    status_code=status.HTTP_200_OK,
    summary="Receive dictation from Voxlen.ai and run the full Sovereign pipeline.",
)
async def voxlen_ingest(
    payload: VoxlenIngestRequest,
    _key: str = Depends(require_api_key),
) -> VoxlenIngestResponse:
    import time
    start = time.monotonic()
    warnings: list[str] = []

    # ── 1. Persist raw payload immediately ──────────────────────────────────
    memory_id: str | None = None
    try:
        from services.memory import store_session
        row = await _in_thread(
            store_session,
            payload.session_id,
            payload.raw_text,
            payload.user_id,
            {
                "source": payload.metadata.source,
                "language": payload.metadata.language,
                "confidence": payload.metadata.confidence,
                "duration_seconds": payload.metadata.duration_seconds,
                **payload.metadata.extra,
            },
        )
        memory_id = row.get("id")
        logger.info("session=%s stored to memory id=%s", payload.session_id, memory_id)
    except RuntimeError:
        # Supabase not configured — warn but continue
        warnings.append("Project Memory unavailable: SUPABASE_URL/KEY not configured.")
        logger.warning("Supabase not configured; skipping memory persistence.")
    except Exception as exc:
        warnings.append(f"Memory write failed: {exc}")
        logger.error("Memory write error for session=%s: %s", payload.session_id, exc)

    # ── 2. Refine via Haiku 4.5 ─────────────────────────────────────────────
    refined: dict = {}
    try:
        from services.refiner import refine

        recent_context: list[dict] = []
        if payload.user_id:
            try:
                from services.memory import get_recent_sessions
                recent_context = await _in_thread(
                    get_recent_sessions, payload.user_id, 5
                )
            except Exception:
                pass  # context is optional

        refined = await _in_thread(refine, payload.raw_text, recent_context)

    except anthropic.APIStatusError as exc:
        if exc.status_code == 529:
            msg = "Anthropic overloaded (529) during refinement — using raw text as fallback."
            warnings.append(msg)
            logger.error(msg)
        else:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        refined = {
            "refined_text": payload.raw_text,
            "intent": payload.raw_text[:120],
            "mcp_refs": [],
            "execution_keyword": None,
            "task_complexity": "simple",
        }
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Refiner error: {exc}") from exc

    refined_text = refined.get("refined_text", payload.raw_text)
    intent = refined.get("intent", "")
    mcp_refs = refined.get("mcp_refs", [])
    execution_keyword = refined.get("execution_keyword")
    task_complexity = refined.get("task_complexity", "simple")

    # ── 3. Patch Supabase with refined data ──────────────────────────────────
    if memory_id:
        try:
            from services.memory import update_session
            await _in_thread(
                update_session,
                payload.session_id,
                refined_text=refined_text,
                intent=intent,
                status="refined",
            )
        except Exception as exc:
            warnings.append(f"Memory update failed: {exc}")

    # ── 4. Execution bridge ──────────────────────────────────────────────────
    execution_result: ExecutionResult | None = None
    should_execute = bool(execution_keyword) or payload.execute

    if should_execute:
        try:
            from services.executor import dispatch
            raw_exec = await _in_thread(
                dispatch,
                refined_text,
                payload.session_id,
                task_complexity,
                mcp_refs,
            )
            execution_result = ExecutionResult(**raw_exec)

            if memory_id:
                try:
                    from services.memory import update_session
                    await _in_thread(
                        update_session,
                        payload.session_id,
                        execution_triggered=True,
                        batch_id=execution_result.batch_id,
                        status=execution_result.status,
                        warnings=warnings,
                    )
                except Exception:
                    pass

        except anthropic.APIStatusError as exc:
            if exc.status_code == 529:
                msg = f"Anthropic overloaded (529) during execution — task queued for retry. Session: {payload.session_id}"
                warnings.append(msg)
                logger.error(msg)
                # Don't raise — let the frontend know via warnings
            else:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
        except Exception as exc:
            warnings.append(f"Execution error: {exc}")
            logger.error("Execution error session=%s: %s", payload.session_id, exc)

    elapsed_ms = round((time.monotonic() - start) * 1000, 1)

    return VoxlenIngestResponse(
        ok=True,
        session_id=payload.session_id,
        memory_id=memory_id,
        refined_text=refined_text,
        intent=intent,
        mcp_refs=mcp_refs,
        execution_keyword=execution_keyword,
        task_complexity=task_complexity,
        execution=execution_result,
        warnings=warnings,
        processing_ms=elapsed_ms,
    )
