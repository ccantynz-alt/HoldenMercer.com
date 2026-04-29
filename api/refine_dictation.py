"""
POST /api/refine-dictation

Accepts a raw audio blob from the browser (MediaRecorder output),
runs it through:
  1. OpenAI Whisper-1  →  raw transcript
  2. Haiku 4.5 Refiner →  structured intent

Returns JSON the frontend can put straight into the command input.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import time

import anthropic
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel

from core.config import get_settings
from core.security import require_api_key

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["dictation"])

_settings = get_settings()


async def _in_thread(fn, *args, **kwargs):
    return await asyncio.get_running_loop().run_in_executor(
        None, lambda: fn(*args, **kwargs)
    )


# ---------------------------------------------------------------------------
# Response model
# ---------------------------------------------------------------------------

class RefineDictationResponse(BaseModel):
    ok: bool
    session_id: str
    transcript: str           # raw Whisper output
    refined_text: str         # Haiku-cleaned intent
    intent: str
    mcp_refs: list[str]
    execution_keyword: str | None
    task_complexity: str
    processing_ms: float


# ---------------------------------------------------------------------------
# Whisper transcription (blocking — runs in thread)
# ---------------------------------------------------------------------------

def _transcribe(audio_bytes: bytes, content_type: str) -> str:
    if not _settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set — Whisper transcription unavailable.")

    from openai import OpenAI
    client = OpenAI(api_key=_settings.openai_api_key)

    # Determine file extension from content-type
    ext_map = {
        "audio/webm": ".webm",
        "audio/ogg": ".ogg",
        "audio/wav": ".wav",
        "audio/mpeg": ".mp3",
        "audio/mp4": ".mp4",
        "audio/x-m4a": ".m4a",
    }
    ext = ext_map.get(content_type.split(";")[0].strip(), ".webm")

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        with open(tmp_path, "rb") as f:
            result = client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
                response_format="text",
            )
        return result.strip()
    finally:
        os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post(
    "/refine-dictation",
    response_model=RefineDictationResponse,
    summary="Audio blob → Whisper transcript → Haiku-refined intent.",
)
async def refine_dictation(
    audio: UploadFile = File(..., description="Audio blob from MediaRecorder."),
    session_id: str = Form(..., description="UUID for this recording."),
    _key: str = Depends(require_api_key),
) -> RefineDictationResponse:
    start = time.monotonic()

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file.")

    # ── 1. Whisper transcription ─────────────────────────────────────────────
    try:
        transcript = await _in_thread(
            _transcribe, audio_bytes, audio.content_type or "audio/webm"
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Whisper error: {exc}") from exc

    if not transcript:
        raise HTTPException(status_code=422, detail="Whisper returned empty transcript.")

    # ── 2. Haiku 4.5 Refiner ────────────────────────────────────────────────
    try:
        from services.refiner import refine
        refined = await _in_thread(refine, transcript)
    except anthropic.APIStatusError as exc:
        if exc.status_code == 529:
            logger.warning("529 during dictation refinement — returning raw transcript.")
            refined = {
                "refined_text": transcript,
                "intent": transcript[:120],
                "mcp_refs": [],
                "execution_keyword": None,
                "task_complexity": "simple",
            }
        else:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Refiner error: {exc}") from exc

    # ── 3. Persist raw audio session ────────────────────────────────────────
    try:
        from services.memory import store_session, update_session
        await _in_thread(
            store_session, session_id, transcript,
            metadata={"source": "whisper", "content_type": audio.content_type},
        )
        await _in_thread(
            update_session, session_id,
            refined_text=refined["refined_text"],
            intent=refined["intent"],
            status="refined",
        )
    except Exception:
        pass  # memory is best-effort here

    return RefineDictationResponse(
        ok=True,
        session_id=session_id,
        transcript=transcript,
        refined_text=refined["refined_text"],
        intent=refined["intent"],
        mcp_refs=refined.get("mcp_refs", []),
        execution_keyword=refined.get("execution_keyword"),
        task_complexity=refined.get("task_complexity", "simple"),
        processing_ms=round((time.monotonic() - start) * 1000, 1),
    )
