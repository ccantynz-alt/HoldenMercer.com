"""
Default notify provider — logs to stderr, never sends real traffic.

This is the safe-everywhere default. Used when:
  - NOTIFY_PROVIDER is unset or = "log"
  - A real provider is configured but its credentials aren't set
  - Tests / dev environments

Returns ok=True so callers can pretend it sent (a missing notification
should never fail the request that triggered it). The log line is the
only side-effect.
"""

from __future__ import annotations

import logging

from .notify import (
    Channel, MailMessage, NotifyProvider, NotifyResult, PushMessage, SmsMessage,
)

logger = logging.getLogger(__name__)


class NotifyLog(NotifyProvider):
    name = "log"

    def is_enabled(self, channel: Channel) -> bool:
        return True   # log "sends" anything

    async def send_mail(self, message: MailMessage) -> NotifyResult:
        logger.info(
            "[notify:log] MAIL to=%s subject=%r body=%d chars",
            ",".join(message.to), message.subject, len(message.body_text),
        )
        return NotifyResult(ok=True, channel="mail", message_id="log:mail")

    async def send_sms(self, message: SmsMessage) -> NotifyResult:
        logger.info(
            "[notify:log] SMS to=%s body=%r", message.to, message.body[:80],
        )
        return NotifyResult(ok=True, channel="sms", message_id="log:sms")

    async def send_push(self, message: PushMessage) -> NotifyResult:
        logger.info(
            "[notify:log] PUSH title=%r url=%s", message.title, message.url,
        )
        return NotifyResult(ok=True, channel="push", message_id="log:push")
