"""
Auth guard for the dashboard API.

Two accepted credentials:
  1. Authorization: Bearer <session_token>  — issued by /api/auth/login,
     signed with SESSION_SECRET, expires after settings.session_ttl_hours.
     This is what the SPA uses.
  2. X-Sovereign-Key: <token>              — legacy shared token, kept so
     curl scripts and CronTech health probes keep working. Only accepted
     if SOVEREIGN_SECRET_KEY (or SOVEREIGN_API_KEY) is set.

If neither ADMIN_PASSWORD nor SOVEREIGN_SECRET_KEY is configured the
backend runs in dev-mode (no auth, dev warning logged). Useful locally;
not safe in production.

The /health and /api/auth/login endpoints are intentionally open.
"""

from __future__ import annotations

import logging
import secrets

from fastapi import Depends, HTTPException, Header, Security, status
from fastapi.security import APIKeyHeader

from core.config import get_settings
from core.session_token import decode_session_token, SessionTokenError

logger = logging.getLogger(__name__)

_legacy_header_scheme = APIKeyHeader(name="X-Sovereign-Key", auto_error=False)


async def require_api_key(
    legacy_key: str | None = Security(_legacy_header_scheme),
    authorization: str | None = Header(default=None),
) -> str:
    """
    FastAPI dependency — accepts a Bearer session token OR the legacy
    X-Sovereign-Key. Returns a string identifying the caller
    ('session:<email>', 'legacy:<key-prefix>', or 'dev-mode').
    """
    settings = get_settings()

    # ── Path A: Bearer session token (the SPA login) ──
    bearer = _extract_bearer(authorization)
    if bearer and settings.session_secret:
        try:
            payload = decode_session_token(bearer, settings.session_secret)
            return f"session:{payload['email']}"
        except SessionTokenError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid session: {exc}",
                headers={"WWW-Authenticate": "Bearer"},
            )

    # ── Path B: legacy X-Sovereign-Key (curl, monitoring) ──
    legacy_configured = settings.sovereign_secret_key or settings.sovereign_api_key
    if legacy_configured and legacy_key and secrets.compare_digest(legacy_key, legacy_configured):
        return f"legacy:{legacy_key[:8]}"

    # ── Path C: dev-mode (no auth configured) ──
    auth_configured = settings.session_secret and settings.admin_password
    if not auth_configured and not legacy_configured:
        logger.warning(
            "No auth configured (ADMIN_PASSWORD / SESSION_SECRET / SOVEREIGN_SECRET_KEY "
            "all unset) — running in dev-mode. Set one before exposing this server."
        )
        return "dev-mode"

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required. Log in at /login or send a valid Bearer token.",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _extract_bearer(header_value: str | None) -> str | None:
    if not header_value:
        return None
    parts = header_value.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None
