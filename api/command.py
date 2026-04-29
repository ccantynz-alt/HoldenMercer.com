"""
Sovereign Command endpoint — unified entry point for the dashboard.

POST /api/command
  mode == "brainstorm"  → Opus 4.7 with extended thinking (xhigh reasoning)
  mode == "execute"     → execution bridge (immediate or Batch API)

All text passes through the Haiku 4.5 Refiner first.
Prompt caching is applied to the repo-context system block to cut costs ~90%.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import time
from pathlib import Path
from functools import lru_cache

import anthropic
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from core.security import require_api_key
from core.resiliency import resilient_create

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["command"])

OPUS_MODEL    = "claude-opus-4-7"
THINKING_BUDGET = 10_000   # tokens — "xhigh" reasoning effort

_BASE_SYSTEM = """\
You are a senior software architect and AI engineering expert embedded in the \
Sovereign AI workspace. Respond precisely and concisely. Prefer code blocks, \
bullet lists, and concrete next actions over prose. When the intent is ambiguous, \
state your assumption explicitly then answer it."""

_PROJECT_ROOT = Path(__file__).parent.parent


# ---------------------------------------------------------------------------
# Repo context for prompt caching
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _repo_file_tree() -> str:
    """
    Returns a concise file tree of the project.
    Cached in-process — refreshed on restart.
    Injected into the system prompt with cache_control so it costs ~10x less
    on repeated calls (Anthropic prompt cache TTL = 5 min).
    """
    excludes = {".venv", "node_modules", "__pycache__", ".git", "dist",
                ".pytest_cache", ".mypy_cache", "*.pyc"}
    lines = ["Project layout:"]
    for p in sorted(_PROJECT_ROOT.rglob("*")):
        rel = p.relative_to(_PROJECT_ROOT)
        parts = rel.parts
        if any(exc.lstrip("*") in str(p) for exc in excludes):
            continue
        if p.is_file() and len(parts) <= 4:
            lines.append(f"  {rel}")
    return "\n".join(lines[:120])


def _cached_system_blocks() -> list[dict]:
    """
    Returns a two-block system prompt list:
      [0] Base instructions         — cached (stable, reused every request)
      [1] Repo file tree context    — cached (stable between restarts)

    Both blocks carry cache_control so Anthropic caches them server-side.
    """
    return [
        {
            "type": "text",
            "text": _BASE_SYSTEM,
            "cache_control": {"type": "ephemeral"},
        },
        {
            "type": "text",
            "text": _repo_file_tree(),
            "cache_control": {"type": "ephemeral"},
        },
    ]


# ---------------------------------------------------------------------------
# Response text extractor — handles thinking blocks
# ---------------------------------------------------------------------------

def _extract_text(response) -> str:
    """
    Opus 4.7 with thinking returns content blocks of type 'thinking' and 'text'.
    We want only the text block.
    """
    if hasattr(response, "content"):
        for block in response.content:
            if getattr(block, "type", None) == "text":
                return block.text
        return response.content[0].text if response.content else ""
    # Bedrock fallback dict
    for block in response.get("content", []):
        if block.get("type") == "text":
            return block["text"]
    return ""


async def _in_thread(fn, *args, **kwargs):
    return await asyncio.get_running_loop().run_in_executor(
        None, lambda: fn(*args, **kwargs)
    )


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class CommandRequest(BaseModel):
    text: str = Field(..., min_length=1)
    mode: str = Field("brainstorm", pattern="^(brainstorm|execute)$")
    session_id: str = Field(...)
    skip_refine: bool = Field(False)
    force_batch: bool = Field(
        False,
        description="Overnight mode — skip immediate execution, queue to Batch API at 50% cost.",
    )


class RefinedInfo(BaseModel):
    raw_text: str
    refined_text: str
    intent: str
    mcp_refs: list[str]
    execution_keyword: str | None
    task_complexity: str


class CommandResponse(BaseModel):
    ok: bool
    session_id: str
    mode: str
    model: str
    refined: RefinedInfo
    response: str | None = None
    thinking_used: bool = False
    execution: dict | None = None
    memory_id: str | None = None
    cache_hit: bool = False
    warnings: list[str] = Field(default_factory=list)
    processing_ms: float


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post(
    "/command",
    response_model=CommandResponse,
    summary="Unified brainstorm (Opus 4.7 + thinking) / execute command.",
)
async def command(
    payload: CommandRequest,
    _key: str = Depends(require_api_key),
) -> CommandResponse:
    start = time.monotonic()
    warnings: list[str] = []
    cache_hit = False

    # ── 1. Refine ────────────────────────────────────────────────────────────
    if payload.skip_refine:
        refined = {
            "refined_text": payload.text,
            "intent": payload.text[:120],
            "mcp_refs": [],
            "execution_keyword": None,
            "task_complexity": "simple",
        }
    else:
        try:
            from services.refiner import refine
            refined = await _in_thread(refine, payload.text)
        except anthropic.APIStatusError as exc:
            if exc.status_code == 529:
                warnings.append("529 during refinement — using raw text.")
                refined = {
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

    refined_text = refined["refined_text"]

    # ── 2. Persist ───────────────────────────────────────────────────────────
    memory_id: str | None = None
    try:
        from services.memory import store_session, update_session
        row = await _in_thread(
            store_session, payload.session_id, payload.text,
            metadata={"mode": payload.mode, "model": OPUS_MODEL},
        )
        memory_id = row.get("id")
        await _in_thread(
            update_session, payload.session_id,
            refined_text=refined_text,
            intent=refined["intent"],
            status="refined",
        )
    except RuntimeError:
        warnings.append("Project Memory unavailable (SUPABASE_URL/KEY not set).")
    except Exception as exc:
        warnings.append(f"Memory write failed: {exc}")

    # ── 3. Route by mode ─────────────────────────────────────────────────────
    response_text: str | None = None
    execution_result: dict | None = None
    thinking_used = False

    if payload.mode == "brainstorm":
        try:
            raw = await _in_thread(
                resilient_create,
                OPUS_MODEL,
                [{"role": "user", "content": refined_text}],
                system=_cached_system_blocks(),
                max_tokens=16_000,
                thinking={"type": "enabled", "budget_tokens": THINKING_BUDGET},
            )
            response_text = _extract_text(raw)
            thinking_used = True

            # Detect cache hit from usage metadata
            if hasattr(raw, "usage"):
                cache_hit = getattr(raw.usage, "cache_read_input_tokens", 0) > 0

        except anthropic.APIStatusError as exc:
            if exc.status_code == 529:
                warnings.append("Anthropic overloaded (529) — brainstorm unavailable.")
            else:
                raise HTTPException(status_code=502, detail=str(exc)) from exc

    else:  # execute
        try:
            from services.executor import dispatch
            # Overnight mode: override complexity to "large" → forces Batch API
            task_complexity = "large" if payload.force_batch else refined.get("task_complexity", "simple")
            execution_result = await _in_thread(
                dispatch,
                refined_text,
                payload.session_id,
                task_complexity,
                refined.get("mcp_refs", []),
            )
        except anthropic.APIStatusError as exc:
            if exc.status_code == 529:
                warnings.append(f"529 during execution — session={payload.session_id}")
            else:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
        except Exception as exc:
            warnings.append(f"Execution error: {exc}")

    return CommandResponse(
        ok=True,
        session_id=payload.session_id,
        mode=payload.mode,
        model=OPUS_MODEL,
        thinking_used=thinking_used,
        refined=RefinedInfo(
            raw_text=payload.text,
            refined_text=refined_text,
            intent=refined["intent"],
            mcp_refs=refined.get("mcp_refs", []),
            execution_keyword=refined.get("execution_keyword"),
            task_complexity=refined.get("task_complexity", "simple"),
        ),
        response=response_text,
        execution=execution_result,
        memory_id=memory_id,
        cache_hit=cache_hit,
        warnings=warnings,
        processing_ms=round((time.monotonic() - start) * 1000, 1),
    )
