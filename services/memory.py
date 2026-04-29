"""
Project Memory — Supabase persistence layer.

Every inbound Voxlen session is stored here before any processing begins,
so nothing is lost even if downstream steps fail.

Expected Supabase table (run once in your Supabase SQL editor):

    create extension if not exists "uuid-ossp";

    create table if not exists voxlen_sessions (
        id           uuid primary key default uuid_generate_v4(),
        session_id   text not null,
        user_id      text,
        raw_text     text not null,
        refined_text text,
        intent       text,
        execution_triggered bool default false,
        batch_id     text,
        status       text default 'received',
        warnings     jsonb default '[]',
        metadata     jsonb default '{}',
        created_at   timestamptz default now(),
        updated_at   timestamptz default now()
    );

    create index on voxlen_sessions (session_id);
    create index on voxlen_sessions (user_id);
    create index on voxlen_sessions (created_at desc);
"""

from __future__ import annotations

import logging
from typing import Any

from core.config import get_settings

logger = logging.getLogger(__name__)

_settings = get_settings()
_supabase_client = None


def _get_client():
    global _supabase_client
    if _supabase_client is None:
        if not _settings.supabase_url or not _settings.supabase_key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_KEY must be set to use Project Memory."
            )
        from supabase import create_client
        _supabase_client = create_client(_settings.supabase_url, _settings.supabase_key)
    return _supabase_client


TABLE = "voxlen_sessions"


def store_session(
    session_id: str,
    raw_text: str,
    user_id: str | None = None,
    metadata: dict | None = None,
) -> dict:
    """
    Immediately persist the raw inbound payload.
    Returns the created row (with generated ``id``).
    Raises on failure — callers must handle so the endpoint can return 503.
    """
    row = {
        "session_id": session_id,
        "raw_text": raw_text,
        "user_id": user_id,
        "metadata": metadata or {},
        "status": "received",
    }
    result = _get_client().table(TABLE).insert(row).execute()
    return result.data[0]


def update_session(session_id: str, **fields) -> dict:
    """
    Patch a session row after refinement / execution.
    ``fields`` maps column names to new values.
    """
    result = (
        _get_client()
        .table(TABLE)
        .update(fields)
        .eq("session_id", session_id)
        .execute()
    )
    return result.data[0] if result.data else {}


def get_recent_sessions(user_id: str, limit: int = 20) -> list[dict]:
    """Retrieve recent sessions for a user (used by the refiner for context)."""
    result = (
        _get_client()
        .table(TABLE)
        .select("session_id, refined_text, intent, created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data
