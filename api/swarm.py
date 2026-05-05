"""
Multi-agent orchestration — Architect / Coder / Reviewer.

POST /api/console/swarm runs three Anthropic calls sequentially against the
same project + repo, each in a different role:

    1. Architect — text-only. Reads the user's request + project brief and
       outputs a numbered plan. No tools, no commits. Bounded output.

    2. Coder — full tools (gated by autonomy). Reads the Architect's plan
       and the project, executes the plan, commits via commit_changes /
       write_github_file. Same tool-use loop as /api/console/stream.

    3. Reviewer — read-only tools. Reads what the Coder produced (commits +
       file contents) and writes a critique: what's good, what's broken,
       what the user should follow up on. Optionally triggers the gate.

The three phases stream one after another over a single SSE response with
a `phase` discriminator on every event so the frontend can pin each delta
to the right agent column.

Sharing primitives with /api/console/stream:
  - same TOOL_SCHEMAS + WRITE_TOOL_NAMES gating
  - same run_tool dispatcher
  - same prompt-caching pattern on system + tools
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator, Literal

import anthropic
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core.config import get_settings
from core.security import require_api_key
from api.console_tools import _all_tool_schemas, run_tool, WRITE_TOOL_NAMES

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/console", tags=["console"])

DEFAULT_MODEL      = "claude-opus-4-7"
DEFAULT_MAX_TOKENS = 4096
MAX_TURNS_PER_PHASE = 10


class SwarmMessage(BaseModel):
    role:    Literal["user", "assistant"]
    content: list | str


class SwarmRequest(BaseModel):
    messages:      list[SwarmMessage]
    system:        str  = ""
    anthropic_key: str  = Field(default="", description="BYOK; never stored.")
    github_token:  str  = ""
    model:         str  = DEFAULT_MODEL
    autonomy:      Literal["manual", "smart", "auto"] = "smart"
    project_name:  str  = ""
    project_brief: str  = ""
    project_repo:  str  = ""
    project_branch: str = ""


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _system_for(phase: str, ctx: SwarmRequest) -> str:
    repo_line = (
        f"\nThe project is linked to GitHub repo `{ctx.project_repo}` (branch: `{ctx.project_branch or 'default'}`)."
        if ctx.project_repo else ""
    )
    brief_line = f"\nProject brief:\n{ctx.project_brief}" if ctx.project_brief.strip() else ""

    if phase == "architect":
        return (
            f"You are the ARCHITECT for project {ctx.project_name!r}.\n"
            f"Your job: read the user's request, weigh tradeoffs, output a "
            f"NUMBERED PLAN with file paths and the actual change. No code, "
            f"no tool calls, no commits — that's the Coder's job.\n"
            f"Be concrete. ≤500 words. End with one line: 'Hand off to Coder.'"
            + repo_line + brief_line
        )
    if phase == "coder":
        return (
            f"You are the CODER for project {ctx.project_name!r}. The Architect "
            f"has handed you a plan. Execute it via tools.\n"
            f"Prefer commit_changes (atomic multi-file commits) over multiple "
            f"write_github_file calls when a logical change touches several files.\n"
            f"When you finish, summarise what you committed in 2-3 sentences. "
            f"Do not include the plan itself in your output — the user has it."
            + repo_line + brief_line
        )
    if phase == "reviewer":
        return (
            f"You are the REVIEWER for project {ctx.project_name!r}. The Coder "
            f"just made commits. Read the changed files (read_github_file) and "
            f"critique:\n"
            f"  • What's good\n"
            f"  • What's broken / risky\n"
            f"  • What the user should follow up on\n"
            f"Use search_repo_code if you need to verify the change integrates "
            f"with existing code. You may trigger the gate to verify nothing "
            f"breaks (run_gate). Do NOT write any files."
            + repo_line + brief_line
        )
    raise ValueError(f"unknown phase: {phase}")


def _tools_for(phase: str, autonomy: str) -> list[dict]:
    schemas = _all_tool_schemas()
    if phase == "architect":
        return []   # Architect plans only, no tools
    if phase == "reviewer":
        # Read-only tools + gate (Reviewer can run the gate but not write code)
        names = [
            "web_fetch", "read_github_file", "list_github_dir", "list_github_repos",
            "search_repo_code", "search_past_sessions",
            "run_gate", "check_gate", "read_gate_logs",
        ]
        return [s for n, s in schemas.items() if n in names]
    if phase == "coder":
        # Coder gets the full toolbox, gated by autonomy
        all_names = list(schemas.keys())
        if autonomy == "manual":
            all_names = [n for n in all_names if n not in WRITE_TOOL_NAMES]
        return [s for n, s in schemas.items() if n in all_names]
    return []


async def _run_phase(
    *,
    phase: str,
    client: anthropic.AsyncAnthropic,
    model: str,
    system_prompt: str,
    messages: list[dict],
    tools: list[dict],
    autonomy: str,
    github_token: str,
    github_org: str,
) -> AsyncIterator[tuple[str, dict]]:
    """
    Run one agent phase. Yields (event, data) tuples that the caller wraps
    with phase metadata before sending as SSE.
    Returns (final_assistant_text, final_messages_list).
    """
    turns = 0
    while turns < MAX_TURNS_PER_PHASE:
        turns += 1
        kwargs = {
            "model":      model,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "messages":   messages,
            "system":     [{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
        }
        if tools:
            cached = [dict(t) for t in tools]
            cached[-1] = {**cached[-1], "cache_control": {"type": "ephemeral"}}
            kwargs["tools"] = cached

        tool_uses: list[dict] = []
        assistant_blocks: list[dict] = []
        stop_reason: str | None = None

        async with client.messages.stream(**kwargs) as resp:
            async for event in resp:
                if event.type == "content_block_delta" and getattr(event.delta, "type", "") == "text_delta":
                    yield ("text_delta", {"delta": event.delta.text})
            final = await resp.get_final_message()
            stop_reason = final.stop_reason
            for block in final.content:
                if block.type == "text":
                    assistant_blocks.append({"type": "text", "text": block.text})
                elif block.type == "tool_use":
                    tu = {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
                    assistant_blocks.append(tu)
                    tool_uses.append(tu)

        messages.append({"role": "assistant", "content": assistant_blocks})
        yield ("turn_end", {"stop_reason": stop_reason or ""})

        if stop_reason != "tool_use" or not tool_uses:
            return

        tool_results: list[dict] = []
        for tu in tool_uses:
            yield ("tool_use_start", {"tool": tu["name"], "input": tu["input"], "id": tu["id"]})
            try:
                output = await run_tool(
                    name=tu["name"], tool_input=tu["input"],
                    github_token=github_token, github_org=github_org,
                    autonomy=autonomy,
                )
                yield ("tool_use_result", {"id": tu["id"], "output": output[:4000]})
                tool_results.append({"type": "tool_result", "tool_use_id": tu["id"], "content": output})
            except Exception as exc:
                msg = f"{type(exc).__name__}: {exc}"
                yield ("tool_use_error", {"id": tu["id"], "error": msg})
                tool_results.append({
                    "type": "tool_result", "tool_use_id": tu["id"],
                    "content": f"ERROR: {msg}", "is_error": True,
                })
        messages.append({"role": "user", "content": tool_results})


@router.post("/swarm", dependencies=[Depends(require_api_key)])
async def swarm_stream(req: SwarmRequest):
    settings = get_settings()
    api_key  = req.anthropic_key or settings.anthropic_api_key
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Anthropic API key required. Add it in Settings (BYOK).",
        )
    github_token = req.github_token or settings.gluecron_github_token

    async def stream() -> AsyncIterator[str]:
        client = anthropic.AsyncAnthropic(api_key=api_key, timeout=settings.request_timeout)

        # Build the original user prompt (last user message in the supplied list).
        user_messages = [m.model_dump() for m in req.messages if m.role == "user"]
        if not user_messages:
            yield _sse("error", {"message": "No user message in request."})
            return

        # Each phase carries its own message list seeded with the prior agent's text.
        # We don't replay tool-use blocks across phases — we feed the *summary text*
        # so Coder/Reviewer have context without conflicting tool_use_id errors.

        try:
            # ── ARCHITECT ──
            yield _sse("phase_start", {"phase": "architect", "label": "Architect"})
            arch_messages = list([m.model_dump() for m in req.messages])  # preserve full history
            arch_text = ""
            async for ev, data in _run_phase(
                phase="architect", client=client, model=req.model,
                system_prompt=_system_for("architect", req),
                messages=arch_messages, tools=[], autonomy=req.autonomy,
                github_token=github_token,
                github_org=settings.gluecron_github_org,
            ):
                if ev == "text_delta":
                    arch_text += data.get("delta", "")
                yield _sse(ev, {**data, "phase": "architect"})
            yield _sse("phase_end", {"phase": "architect", "summary": arch_text[:8000]})

            # ── CODER ──
            yield _sse("phase_start", {"phase": "coder", "label": "Coder"})
            coder_messages: list[dict] = [
                {"role": "user", "content":
                    f"Original user request:\n{user_messages[-1].get('content', '')}\n\n"
                    f"Architect's plan:\n{arch_text.strip()}\n\n"
                    "Execute the plan now."
                }
            ]
            coder_text = ""
            async for ev, data in _run_phase(
                phase="coder", client=client, model=req.model,
                system_prompt=_system_for("coder", req),
                messages=coder_messages,
                tools=_tools_for("coder", req.autonomy),
                autonomy=req.autonomy,
                github_token=github_token,
                github_org=settings.gluecron_github_org,
            ):
                if ev == "text_delta":
                    coder_text += data.get("delta", "")
                yield _sse(ev, {**data, "phase": "coder"})
            yield _sse("phase_end", {"phase": "coder", "summary": coder_text[:8000]})

            # ── REVIEWER ──
            yield _sse("phase_start", {"phase": "reviewer", "label": "Reviewer"})
            reviewer_messages: list[dict] = [
                {"role": "user", "content":
                    f"Original user request:\n{user_messages[-1].get('content', '')}\n\n"
                    f"Architect's plan:\n{arch_text.strip()}\n\n"
                    f"Coder's report:\n{coder_text.strip()}\n\n"
                    "Review the recent commits in the linked repo. Critique."
                }
            ]
            review_text = ""
            async for ev, data in _run_phase(
                phase="reviewer", client=client, model=req.model,
                system_prompt=_system_for("reviewer", req),
                messages=reviewer_messages,
                tools=_tools_for("reviewer", req.autonomy),
                autonomy=req.autonomy,
                github_token=github_token,
                github_org=settings.gluecron_github_org,
            ):
                if ev == "text_delta":
                    review_text += data.get("delta", "")
                yield _sse(ev, {**data, "phase": "reviewer"})
            yield _sse("phase_end", {"phase": "reviewer", "summary": review_text[:8000]})

            yield _sse("done", {"phases": ["architect", "coder", "reviewer"]})
        except anthropic.APIStatusError as exc:
            yield _sse("error", {"message": f"Anthropic {exc.status_code}: {exc.message}"})
        except Exception as exc:
            logger.exception("Swarm crashed")
            yield _sse("error", {"message": f"{type(exc).__name__}: {exc}"})
        finally:
            await client.close()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )
