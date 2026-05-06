"""
CronTech notify provider — STUB.

CronTech is our Cloudflare/Vercel/Render/Mailgun/Twilio replacement.
Per the integration context shared in the PR thread, CronTech ships
the following outbound channels (Holden Mercer cares about these):

    Mail        (the Mailgun / SendGrid replacement)
    SMS         (the Twilio replacement, vendored via Sinch internally)
    Voice       (rarely needed by Holden Mercer)
    Codes       (one-time-codes — also rarely needed by HM)

This file exists so the factory has a target named "crontech" and so
the abstraction layer can be wired up everywhere RIGHT NOW. As soon as
the precise endpoint specs land we drop them in here and every caller
upgrades from log → real send with no other code changes.

WHAT THIS STUB NEEDS TO BECOME A REAL ADAPTER (specs pending):

  AUTH:
    - Bearer token? Signed-request HMAC? OAuth client-credentials?
    - Header name (Authorization vs custom)
    - Token prefix convention (matches GlueCron's glc_? Different?)

  MAIL — POST <crontech_api_url>/<???>
    - Endpoint path (e.g. /v1/mail/send? /api/mail? something else?)
    - Body schema:  to, subject, html, text, from, reply_to, tags?
    - Returns:      message_id shape, status fields
    - Idempotency:  is there a header like Crontech-Idempotency-Key?

  SMS — POST <crontech_api_url>/<???>
    - Endpoint path
    - Body schema:  to (E.164), body, from? sender_id?
    - Country / number-range validation?
    - Returns:      message_id, segment count for billing display

  PUSH:
    - Does CronTech ship its own push? (The spec mentions Realtime
      under the platform list but not a "Push" service explicitly.)
    - Or do we keep web push via VAPID for now and let CronTech
      handle Mail + SMS only?

  RATE LIMITS / RETRIES:
    - Per-channel ceilings?
    - Are 429s retried automatically by the provider, or do we?

Until the above is filled in, every method here returns a clear
"not configured" NotifyResult so callers can fall back to NotifyLog
without crashing.

DOCTRINE NOTE — naming:
The CronTech context locks customer-facing terminology. If/when we
expose CronTech-routed notifications in user-facing copy on the SPA,
say "Mail" / "SMS" / "Voice" — never "Mailgun", "SendGrid", "Twilio",
"Sinch", or any other competitor name.
"""

from __future__ import annotations

import logging

from .notify import (
    Channel, MailMessage, NotifyProvider, NotifyResult, PushMessage, SmsMessage,
)

logger = logging.getLogger(__name__)


class NotifyCronTech(NotifyProvider):
    name = "crontech"

    def __init__(
        self,
        api_url: str | None = None,
        api_key: str | None = None,
    ) -> None:
        from core.config import get_settings
        s = get_settings()
        self.api_url = (api_url or s.crontech_api_url or "").rstrip("/")
        self.api_key = api_key or s.crontech_api_key or ""

    @property
    def _has_creds(self) -> bool:
        return bool(self.api_url and self.api_key)

    def is_enabled(self, channel: Channel) -> bool:
        # Conservative: report disabled until we have a real adapter.
        # Setting CRONTECH_API_URL + CRONTECH_API_KEY alone isn't enough —
        # we need the channel-specific endpoint layout too.
        return False

    async def send_mail(self, message: MailMessage) -> NotifyResult:
        return self._stub_result("mail")

    async def send_sms(self, message: SmsMessage) -> NotifyResult:
        return self._stub_result("sms")

    async def send_push(self, message: PushMessage) -> NotifyResult:
        return self._stub_result("push")

    def _stub_result(self, channel: Channel) -> NotifyResult:
        if not self._has_creds:
            return NotifyResult(
                ok=False, channel=channel,
                error=(
                    "CronTech credentials not configured. Set CRONTECH_API_URL "
                    "+ CRONTECH_API_KEY, then provide endpoint specs to upgrade "
                    "this stub into a real adapter."
                ),
            )
        return NotifyResult(
            ok=False, channel=channel,
            error=(
                "CronTech notify adapter is a stub. Endpoint specs pending — "
                f"see core/providers/notify_crontech.py for the list of needed details. "
                f"Falling back to NotifyLog is safe."
            ),
        )
