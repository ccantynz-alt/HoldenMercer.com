"""
Single-user email/password login.

POST /api/auth/login   {email, password}  → {token, expires_at, email}
GET  /api/auth/me                         → {email}  (requires Bearer token)

Credentials live in env vars (ADMIN_EMAIL, ADMIN_PASSWORD). Tokens are
stdlib HMAC-signed (see core.session_token). No user database.
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from core.config import get_settings
from core.security import require_api_key
from core.session_token import (
    SessionTokenError,
    constant_time_equals,
    encode_session_token,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email:    str
    password: str


class LoginResponse(BaseModel):
    token:      str
    expires_at: int        # unix seconds
    email:      str


class MeResponse(BaseModel):
    email: str


@router.post("/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    settings = get_settings()

    if not (settings.admin_email and settings.admin_password and settings.session_secret):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Login is not configured. Set ADMIN_EMAIL, ADMIN_PASSWORD, and "
                "SESSION_SECRET env vars."
            ),
        )

    # Compare both fields constant-time. Always check both even if email is wrong
    # so we don't leak which field failed via timing.
    email_ok = constant_time_equals(req.email.lower(), settings.admin_email.lower())
    pw_ok    = constant_time_equals(req.password, settings.admin_password)
    if not (email_ok and pw_ok):
        # Log the email for visibility but never the password
        logger.warning("Failed login attempt for email=%s", req.email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    ttl = settings.session_ttl_hours * 3600
    try:
        token, expires_at = encode_session_token(
            email=settings.admin_email,
            secret=settings.session_secret,
            ttl_seconds=ttl,
        )
    except SessionTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )

    logger.info("Login success for email=%s, ttl=%ds", settings.admin_email, ttl)
    return LoginResponse(token=token, expires_at=expires_at, email=settings.admin_email)


@router.get("/me", response_model=MeResponse, dependencies=[Depends(require_api_key)])
async def me(caller: str = Depends(require_api_key)):
    """
    Returns the current session's email so the SPA can confirm a token is still valid.
    `caller` is 'session:<email>' for Bearer tokens, 'legacy:<prefix>' for X-Sovereign-Key,
    or 'dev-mode' if no auth is configured.
    """
    settings = get_settings()
    if caller.startswith("session:"):
        return MeResponse(email=caller.split(":", 1)[1])
    return MeResponse(email=settings.admin_email or "dev-mode")
