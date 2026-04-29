"""
Haiku 4.5 Refiner — cleans up Voxlen dictation into structured technical intent.

Responsibilities:
  - Strip stutters, filler words, and dictation artefacts.
  - Detect file names and GitHub repo mentions, flag them for MCP cross-reference.
  - Return a structured dict: {refined_text, intent, mcp_refs, execution_keyword}.
"""

from __future__ import annotations

import json
import logging
import re

from core.resiliency import resilient_create

logger = logging.getLogger(__name__)

HAIKU_MODEL = "claude-haiku-4-5-20251001"

# Words that must trigger the execution bridge when they open the refined intent.
EXECUTION_KEYWORDS = {"execute", "build", "refactor", "create", "deploy", "fix", "update", "migrate"}

_SYSTEM_PROMPT = """\
You are a technical dictation refiner for a software engineer.
Your job is to convert raw speech-to-text (which may contain stutters, repeated \
words, and filler phrases) into clean, structured technical requirements.

Rules:
1. Extract the core technical intent. Remove stutters (um, uh, like, you know), \
   false starts, and repeated words.
2. If the user mentions a file name (e.g. "resiliency dot py", "gateway.py"), \
   normalise it and mark it in mcp_refs.
3. If the user mentions a GitHub repository or URL, extract and include it in mcp_refs.
4. Identify if the first meaningful action word is an execution keyword \
   (execute, build, refactor, create, deploy, fix, update, migrate). \
   Return it as execution_keyword (lowercase) or null.
5. Estimate task_complexity: "simple" (<30 min), "medium" (30–120 min), \
   "large" (>120 min / overnight). Only "large" tasks get batched.

Respond ONLY with valid JSON in this exact shape:
{
  "refined_text": "<clean requirement>",
  "intent": "<one-sentence summary>",
  "mcp_refs": ["<filename or repo>"],
  "execution_keyword": "<keyword or null>",
  "task_complexity": "simple|medium|large"
}"""


def _extract_text(response) -> str:
    """Normalise response from either anthropic.types.Message or Bedrock dict."""
    if hasattr(response, "content"):
        return response.content[0].text
    # Bedrock dict shape
    return response["content"][0]["text"]


def refine(raw_text: str, recent_context: list[dict] | None = None) -> dict:
    """
    Refine raw dictation text.

    ``recent_context`` is a list of recent session summaries injected into the
    prompt so Haiku can resolve pronouns like "that endpoint" or "the same repo".

    Returns:
        {
          "refined_text": str,
          "intent": str,
          "mcp_refs": list[str],
          "execution_keyword": str | None,
          "task_complexity": "simple" | "medium" | "large",
        }
    """
    user_content = f"Raw dictation:\n{raw_text}"

    if recent_context:
        snippets = "\n".join(
            f"- [{s['created_at']}] {s.get('intent', s.get('refined_text', ''))}"
            for s in recent_context[:5]
        )
        user_content = (
            f"Recent session history (for context only, do not repeat):\n"
            f"{snippets}\n\n"
            f"{user_content}"
        )

    response = resilient_create(
        model=HAIKU_MODEL,
        messages=[{"role": "user", "content": user_content}],
        system=_SYSTEM_PROMPT,
        max_tokens=512,
        temperature=0.1,
    )

    raw_json = _extract_text(response)

    # Strip markdown code fences if Haiku wraps the JSON
    raw_json = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_json.strip())

    try:
        result = json.loads(raw_json)
    except json.JSONDecodeError:
        logger.warning("Haiku returned non-JSON; falling back to raw text. Got: %s", raw_json[:200])
        result = {
            "refined_text": raw_text,
            "intent": raw_text[:120],
            "mcp_refs": [],
            "execution_keyword": None,
            "task_complexity": "simple",
        }

    # Normalise execution_keyword
    kw = (result.get("execution_keyword") or "").lower().strip()
    result["execution_keyword"] = kw if kw in EXECUTION_KEYWORDS else None

    return result
