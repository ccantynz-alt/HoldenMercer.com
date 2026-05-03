"""
Console — agentic chat endpoint with tool use, streaming via SSE.

POST /api/console/stream
Body:
    messages:        list of {role, content} (Claude format)
    system:          str  — system prompt (auto-includes the project Brief)
    anthropic_key:   str  — BYOK; never persisted server-side
    github_token:    str  — optional per-request override of GLUECRON_GITHUB_TOKEN
    model:           str  — defaults to claude-opus-4-7
    tools_enabled:   list[str]  — subset of ["web_fetch","read_github_file","list_github_repos"]
    autonomy:        "manual" | "smart" | "auto" — informational; backend just runs the loop

Streamed SSE events:
    text_delta       {delta: str}
    tool_use_start   {tool: str, input: dict, id: str}
    tool_use_result  {id: str, output: str}
    tool_use_error   {id: str, error: str}
    turn_end         {stop_reason: str}
    done             {turns: int}
    error            {message: str}
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
from api.console_tools import TOOL_SCHEMAS, WRITE_TOOL_NAMES, run_tool, _all_tool_schemas

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/console", tags=["console"])

MAX_TURNS_PER_REQUEST = 12          # safety net against runaway tool use
DEFAULT_MODEL         = "claude-opus-4-7"
DEFAULT_MAX_TOKENS    = 4096


class ConsoleMessage(BaseModel):
    role:    Literal["user", "assistant"]
    content: list | str            # Anthropic accepts strings or content-block lists


class ConsoleRequest(BaseModel):
    messages:      list[ConsoleMessage]
    system:        str  = ""
    anthropic_key: str  = Field(default="", description="BYOK; never stored server-side")
    github_token:  str  = ""
    model:         str  = DEFAULT_MODEL
    tools_enabled: list[str] = Field(default_factory=lambda: list(_all_tool_schemas().keys()))
    autonomy:      Literal["manual", "smart", "auto"] = "smart"
    max_tokens:    int  = DEFAULT_MAX_TOKENS


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _build_tool_specs(enabled: list[str], autonomy: str) -> list[dict]:
    """
    Filter the tool specs by:
      1. The frontend's `tools_enabled` allow-list (a subset of all known tools).
      2. The autonomy mode — `manual` strips out anything that mutates state, so
         in manual mode Claude can plan and read but never commits anything.
    """
    available = list(enabled)
    if autonomy == "manual":
        available = [t for t in available if t not in WRITE_TOOL_NAMES]
    schemas = _all_tool_schemas()
    return [spec for name, spec in schemas.items() if name in available]


@router.post("/stream", dependencies=[Depends(require_api_key)])
async def console_stream(req: ConsoleRequest):
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
        # Convert pydantic messages to dicts that Anthropic accepts as-is.
        messages = [m.model_dump() for m in req.messages]
        tools    = _build_tool_specs(req.tools_enabled, req.autonomy)

        turns = 0
        try:
            while turns < MAX_TURNS_PER_REQUEST:
                turns += 1
                # ── Claude turn (streaming) ──
                tool_uses:    list[dict] = []
                assistant_blocks: list[dict] = []
                stop_reason: str | None  = None

                kwargs = {
                    "model":      req.model,
                    "max_tokens": req.max_tokens,
                    "messages":   messages,
                }
                if req.system:
                    kwargs["system"] = req.system
                if tools:
                    kwargs["tools"] = tools

                async with client.messages.stream(**kwargs) as resp:
                    async for event in resp:
                        # Text deltas — stream straight to the SPA
                        if event.type == "content_block_delta" and getattr(event.delta, "type", "") == "text_delta":
                            yield _sse("text_delta", {"delta": event.delta.text})

                    final = await resp.get_final_message()
                    stop_reason = final.stop_reason
                    for block in final.content:
                        # Convert SDK objects to plain dicts so we can append into `messages`
                        if block.type == "text":
                            assistant_blocks.append({"type": "text", "text": block.text})
                        elif block.type == "tool_use":
                            tool_use_dict = {
                                "type":  "tool_use",
                                "id":    block.id,
                                "name":  block.name,
                                "input": block.input,
                            }
                            assistant_blocks.append(tool_use_dict)
                            tool_uses.append(tool_use_dict)

                # Append the assistant turn to history
                messages.append({"role": "assistant", "content": assistant_blocks})
                yield _sse("turn_end", {"stop_reason": stop_reason or ""})

                # No tool use → conversation turn is complete
                if stop_reason != "tool_use" or not tool_uses:
                    break

                # ── Execute every tool call, return results in a single user turn ──
                tool_results: list[dict] = []
                for tu in tool_uses:
                    yield _sse("tool_use_start", {"tool": tu["name"], "input": tu["input"], "id": tu["id"]})
                    try:
                        output = await run_tool(
                            name=tu["name"],
                            tool_input=tu["input"],
                            github_token=github_token,
                            github_org=settings.gluecron_github_org,
                        )
                        yield _sse("tool_use_result", {"id": tu["id"], "output": _truncate_for_event(output)})
                        tool_results.append({
                            "type":         "tool_result",
                            "tool_use_id":  tu["id"],
                            "content":      output,
                        })
                    except Exception as exc:  # noqa: BLE001
                        msg = f"{type(exc).__name__}: {exc}"
                        logger.warning("Tool %s failed: %s", tu["name"], msg)
                        yield _sse("tool_use_error", {"id": tu["id"], "error": msg})
                        tool_results.append({
                            "type":         "tool_result",
                            "tool_use_id":  tu["id"],
                            "content":      f"ERROR: {msg}",
                            "is_error":     True,
                        })

                messages.append({"role": "user", "content": tool_results})

            yield _sse("done", {"turns": turns})

        except anthropic.APIStatusError as exc:
            logger.error("Anthropic %s: %s", exc.status_code, exc.message)
            yield _sse("error", {"message": f"Anthropic {exc.status_code}: {exc.message}"})
        except Exception as exc:  # noqa: BLE001
            logger.exception("Console stream crashed")
            yield _sse("error", {"message": f"{type(exc).__name__}: {exc}"})
        finally:
            await client.close()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":      "no-cache, no-transform",
            "X-Accel-Buffering":  "no",
            "Connection":         "keep-alive",
        },
    )


def _truncate_for_event(content: str, limit: int = 4000) -> str:
    """Tool outputs can be huge — keep the SSE event small. Claude still gets the full content."""
    if len(content) <= limit:
        return content
    return content[:limit] + f"\n…[truncated for SSE preview, full {len(content)} chars sent to Claude]"
