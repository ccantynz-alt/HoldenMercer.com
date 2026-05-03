"""
Stdlib-only signed session tokens. No JWT library, no extra deps.

Format:  <base64url(payload_json)>.<base64url(hmac_sha256(payload, secret))>

Payload fields:
    email   — the logged-in admin's email
    iat     — issued-at unix timestamp
    exp     — expires-at unix timestamp

Verification is constant-time. Expired tokens raise SessionTokenError.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time


class SessionTokenError(Exception):
    """Raised when a session token is malformed, tampered, or expired."""


def encode_session_token(email: str, secret: str, ttl_seconds: int) -> tuple[str, int]:
    """Returns (token, expires_at_unix)."""
    if not secret:
        raise SessionTokenError("SESSION_SECRET is empty — cannot sign tokens.")
    now     = int(time.time())
    expires = now + ttl_seconds
    payload = {"email": email, "iat": now, "exp": expires}
    payload_b64 = _b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig_b64     = _b64encode(_hmac(payload_b64.encode("ascii"), secret))
    return f"{payload_b64}.{sig_b64}", expires


def decode_session_token(token: str, secret: str) -> dict:
    """Returns the payload dict if valid. Raises SessionTokenError otherwise."""
    if not secret:
        raise SessionTokenError("SESSION_SECRET is empty — cannot verify tokens.")
    try:
        payload_b64, sig_b64 = token.split(".", 1)
    except ValueError:
        raise SessionTokenError("Malformed token.")

    expected_sig = _hmac(payload_b64.encode("ascii"), secret)
    try:
        actual_sig = _b64decode(sig_b64)
    except Exception:
        raise SessionTokenError("Invalid signature encoding.")

    if not hmac.compare_digest(expected_sig, actual_sig):
        raise SessionTokenError("Signature mismatch.")

    try:
        payload = json.loads(_b64decode(payload_b64).decode("utf-8"))
    except Exception:
        raise SessionTokenError("Invalid payload encoding.")

    if "exp" not in payload or "email" not in payload:
        raise SessionTokenError("Missing required claims.")

    if int(payload["exp"]) < int(time.time()):
        raise SessionTokenError("Token expired.")

    return payload


# ── Internals ───────────────────────────────────────────────────────────────

def _hmac(data: bytes, secret: str) -> bytes:
    return hmac.new(secret.encode("utf-8"), data, hashlib.sha256).digest()


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def constant_time_equals(a: str, b: str) -> bool:
    """Wrapper around secrets.compare_digest for symmetry with the rest of the module."""
    return secrets.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
