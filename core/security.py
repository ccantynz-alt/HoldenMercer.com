"""
API key guard for the Sovereign Engine.

Every protected endpoint requires the header:
    X-Sovereign-Key: <value of SOVEREIGN_API_KEY in .env>

Behaviour:
  - SOVEREIGN_API_KEY not set → dev-mode: all requests pass with a log warning.
    This lets you run locally without a key configured.
  - Key set + header missing or wrong → HTTP 401.
  - Key set + header correct → passes through.

The /health endpoint is intentionally NOT protected (used by monitoring).
"""

from __future__ import annotations

import logging
import secrets

from fastapi import Depends, HTTPException, Security, status
from fastapi.security import APIKeyHeader

from core.config import get_settings

logger = logging.getLogger(__name__)

_header_scheme = APIKeyHeader(name="X-Sovereign-Key", auto_error=False)


async def require_api_key(key: str | None = Security(_header_scheme)) -> str:
    """
    FastAPI dependency — inject with ``Depends(require_api_key)``.
    Returns the validated key string (or "dev-mode").
    """
    settings = get_settings()
    # SOVEREIGN_SECRET_KEY takes precedence over the legacy SOVEREIGN_API_KEY
    configured_key = settings.sovereign_secret_key or settings.sovereign_api_key

    if not configured_key or settings.development_mode:
        logger.warning(
            "SOVEREIGN_API_KEY is not set — running in dev-mode (no auth). "
            "Set the key in .env before exposing this server publicly."
        )
        return "dev-mode"

    if not key or not secrets.compare_digest(key, configured_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key. Add header: X-Sovereign-Key: <your key>",
            headers={"WWW-Authenticate": "ApiKey"},
        )

    return key
