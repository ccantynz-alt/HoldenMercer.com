"""
POST /api/refine

Lightweight text-only refinement endpoint.
Accepts a raw transcript from Deepgram (or any source), runs it through
Haiku 4.5, and returns the structured intent — no storage, no execution.

Designed to be called in the `speech_final` handler of SovereignVoice.ts
so the UI can show the cleaned text before the user decides to execute.
"""

from __future__ import annotations

import asyncio
import logging
import time

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.security import require_api_key

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["refine"])


async def _in_thread(fn, *args, **kwargs):
    return await asyncio.get_running_loop().run_in_executor(
        None, lambda: fn(*args, **kwargs)
    )


class RefineRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Raw transcript from Deepgram.")
    session_id: str = Field(..., description="UUID — tie this to the voice session.")


class RefineResponse(BaseModel):
    ok: bool
    session_id: str
    transcript: str          # original input (unchanged)
    refined_text: str        # Haiku-cleaned intent
    intent: str
    mcp_refs: list[str]
    execution_keyword: str | None
    task_complexity: str
    processing_ms: float


@router.post(
    "/refine",
    response_model=RefineResponse,
    summary="Raw transcript → Haiku 4.5 → structured intent. No side-effects.",
)
async def refine_text(
    payload: RefineRequest,
    _key: str = Depends(require_api_key),
) -> RefineResponse:
    start = time.monotonic()

    try:
        from services.refiner import refine
        result = await _in_thread(refine, payload.text)
    except anthropic.APIStatusError as exc:
        if exc.status_code == 529:
            logger.warning("529 during /api/refine — returning raw text.")
            result = {
                "refined_text": payload.text,
                "intent": payload.text[:120],
                "mcp_refs": [],
                "execution_keyword": None,
                "task_complexity": "simple",
            }
        else:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Refiner error: {exc}") from exc

    return RefineResponse(
        ok=True,
        session_id=payload.session_id,
        transcript=payload.text,
        refined_text=result["refined_text"],
        intent=result["intent"],
        mcp_refs=result.get("mcp_refs", []),
        execution_keyword=result.get("execution_keyword"),
        task_complexity=result.get("task_complexity", "simple"),
        processing_ms=round((time.monotonic() - start) * 1000, 1),
    )
