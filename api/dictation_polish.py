"""
POST /api/dictation/polish

Style-aware long-form polish for the Dictation Studio.

Pipeline:
    Raw transcript  →  Haiku 4.5 with style-specific system prompt
                    →  polished prose (no JSON, just clean text)

Distinct from /api/refine, which returns *structured intent* for command
execution. This endpoint preserves narrative — paragraphs, voice, length —
and only fixes grammar, repetition, and tone to match the requested style.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Literal

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.security import require_api_key
from core.resiliency import resilient_create

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/dictation", tags=["dictation"])

HAIKU_MODEL = "claude-haiku-4-5-20251001"

WritingStyle = Literal["professional", "casual", "academic", "creative", "technical"]

_STYLE_PROMPTS: dict[str, str] = {
    "professional": (
        "Polish this raw dictation into clear, professional business prose. "
        "Fix grammar, punctuation, and capitalisation. Remove stutters, filler words "
        "('um', 'uh', 'like', 'you know'), false starts, and accidental repetition. "
        "Keep the author's voice and structure — do not summarise, do not embellish. "
        "Tone: confident, direct, polished."
    ),
    "casual": (
        "Polish this raw dictation into a warm, conversational piece of writing. "
        "Fix grammar, punctuation, and capitalisation. Remove stutters and filler "
        "words but keep contractions, idioms, and the natural flow of the speaker. "
        "Tone: relaxed, friendly, human."
    ),
    "academic": (
        "Polish this raw dictation into formal academic prose. "
        "Fix grammar, punctuation, and capitalisation. Replace colloquialisms with "
        "precise vocabulary. Use third-person voice unless the original is clearly "
        "first-person reflection. Preserve all factual claims; do not invent citations. "
        "Tone: formal, measured, citation-friendly."
    ),
    "creative": (
        "Polish this raw dictation into vivid, narrative prose. "
        "Fix grammar and punctuation but preserve the writer's voice and rhythm. "
        "Tighten weak verbs, vary sentence length, and let imagery breathe. "
        "Do not invent new plot points or facts; only sharpen what is already there. "
        "Tone: evocative, rhythmic, alive."
    ),
    "technical": (
        "Polish this raw dictation into precise technical writing. "
        "Fix grammar and punctuation. Use exact technical vocabulary; format code "
        "identifiers, file paths, and commands in `backticks`. Convert any spoken "
        "punctuation ('dot py', 'slash') into the correct symbols. "
        "Be terse — drop redundant qualifiers. Keep the author's reasoning intact. "
        "Tone: precise, terse, code-aware."
    ),
}


async def _in_thread(fn, *args, **kwargs):
    return await asyncio.get_running_loop().run_in_executor(
        None, lambda: fn(*args, **kwargs)
    )


# ── Request / response ─────────────────────────────────────────────────────


class PolishRequest(BaseModel):
    text:       str          = Field(..., min_length=1, max_length=20_000)
    style:      WritingStyle = "professional"
    session_id: str          = Field(..., description="Client-side session UUID.")


class PolishResponse(BaseModel):
    ok:             bool
    session_id:     str
    style:          WritingStyle
    raw:            str
    polished:       str
    word_count_in:  int
    word_count_out: int
    processing_ms:  float


def _extract_text(response) -> str:
    if hasattr(response, "content"):
        return response.content[0].text
    return response["content"][0]["text"]  # Bedrock dict shape


def _polish_blocking(text: str, style: WritingStyle) -> str:
    system = _STYLE_PROMPTS[style] + (
        "\n\nReturn ONLY the polished prose. No preamble, no explanation, "
        "no markdown headers, no bullet points unless the original has them."
    )
    response = resilient_create(
        model=HAIKU_MODEL,
        messages=[{"role": "user", "content": f"Raw dictation:\n\n{text}"}],
        system=system,
        max_tokens=4096,
        temperature=0.3,
    )
    return _extract_text(response).strip()


# ── Endpoint ───────────────────────────────────────────────────────────────


@router.post(
    "/polish",
    response_model=PolishResponse,
    summary="Style-aware long-form grammar / tone polish via Haiku 4.5.",
)
async def polish(
    payload: PolishRequest,
    _key: str = Depends(require_api_key),
) -> PolishResponse:
    start = time.monotonic()

    try:
        polished = await _in_thread(_polish_blocking, payload.text, payload.style)
    except anthropic.APIStatusError as exc:
        if exc.status_code == 529:
            logger.warning("529 during /api/dictation/polish — returning raw text.")
            polished = payload.text
        else:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Polish error: {exc}") from exc

    raw_words      = len(payload.text.split()) if payload.text.strip() else 0
    polished_words = len(polished.split())     if polished.strip() else 0

    return PolishResponse(
        ok=True,
        session_id=payload.session_id,
        style=payload.style,
        raw=payload.text,
        polished=polished,
        word_count_in=raw_words,
        word_count_out=polished_words,
        processing_ms=round((time.monotonic() - start) * 1000, 1),
    )
