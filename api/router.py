"""
Command Router — translates voice transcripts into structured Action Packets
for GlueCron and the Sovereign execution pipeline.

POST /api/route
  Input:  { transcript, session_id, context? }
  Output: ActionPacket

Action Packets are typed intents that downstream consumers (GlueCron Committer,
executor.py, infra_bridge.py) can act on without re-parsing natural language.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from core.resiliency import resilient_create
from core.security import require_api_key

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["router"])

# ── Action catalogue ──────────────────────────────────────────────────────────
# Every recognised action maps to a downstream handler.

ACTION_CATALOGUE = """
AUTONOMOUS_REFACTOR  — Rewrite or improve the current file / selection.
CREATE_FILE          — Create a new file with the specified name and content.
GIT_COMMIT           — Stage changes and commit to GlueCron repo.
GIT_PUSH             — Push committed changes to remote branch.
DEPLOY               — Trigger a CronTech deployment for a named repo/instance.
SEARCH_MEMORY        — Semantic search across GlueCron indexed repos.
EXPLAIN              — Explain the current file, selection, or concept.
RUN_TESTS            — Execute the test suite for the current repo.
OPEN_FILE            — Navigate to / load a specific file path.
ANSWER               — General question/answer — no code action needed.
UNKNOWN              — Could not confidently classify the intent.
"""

_ROUTER_SYSTEM = f"""\
You are the Sovereign Command Router. Given a voice transcript and optional context,
return a single JSON object with exactly these fields:

  action   : one of [{', '.join(a.split('—')[0].strip() for a in ACTION_CATALOGUE.strip().splitlines())}]
  target   : string | null  — file path, repo name, or concept the action applies to
  args     : object         — action-specific arguments (may be empty {{}})
  confidence: float 0-1     — how confident you are in this classification
  reasoning : string        — one sentence explaining the classification

Return ONLY valid JSON. No markdown, no preamble.

Action catalogue:
{ACTION_CATALOGUE}
"""

# ── Models ────────────────────────────────────────────────────────────────────

class RouteRequest(BaseModel):
    transcript: str
    session_id: str
    context: dict = Field(default_factory=dict)
    # context may include: current_file, current_repo, recent_actions


class ActionPacket(BaseModel):
    action:     str
    target:     str | None
    args:       dict
    confidence: float
    reasoning:  str
    session_id: str
    raw_transcript: str


# ── Route ─────────────────────────────────────────────────────────────────────

@router.post("/route", dependencies=[Depends(require_api_key)])
async def route_command(req: RouteRequest) -> ActionPacket:
    """
    Classify a voice transcript into a structured Action Packet.

    The router uses Haiku 4.5 for speed — routing decisions should be
    near-instant so execution can begin without perceptible delay.
    """
    import asyncio
    loop = asyncio.get_running_loop()

    context_str = ""
    if req.context:
        context_str = "\n\nCurrent context:\n" + "\n".join(
            f"  {k}: {v}" for k, v in req.context.items()
        )

    packet = await loop.run_in_executor(None, lambda: _classify(
        req.transcript, context_str, req.session_id
    ))
    return packet


def _classify(transcript: str, context_str: str, session_id: str) -> ActionPacket:
    response = resilient_create(
        model="claude-haiku-4-5-20251001",
        messages=[{
            "role": "user",
            "content": f'Transcript: "{transcript}"{context_str}',
        }],
        system=_ROUTER_SYSTEM,
        max_tokens=256,
    )

    text = (
        response.content[0].text
        if hasattr(response, "content")
        else response["content"][0]["text"]
    )

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Fallback if model returns malformed JSON
        logger.warning("Router returned non-JSON: %s", text[:200])
        data = {
            "action": "UNKNOWN",
            "target": None,
            "args": {},
            "confidence": 0.0,
            "reasoning": "Router classification failed — JSON parse error.",
        }

    logger.info(
        "route session=%s transcript=%r → action=%s confidence=%.2f",
        session_id, transcript[:60], data.get("action"), data.get("confidence", 0),
    )

    return ActionPacket(
        session_id=session_id,
        raw_transcript=transcript,
        **{k: data.get(k) for k in ("action", "target", "args", "confidence", "reasoning")},
    )
