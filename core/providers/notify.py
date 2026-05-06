"""
NotifyProvider — abstraction over outbound transactional channels:
mail, SMS, push, voice. CronTech is the eventual provider for all of
these (it replaces the Mailgun + Twilio + Web Push slots). Until the
specific CronTech REST endpoints + auth model land, the default
implementation here is `NotifyLog` (logs to stderr, no real send) so
the rest of the system can call notify code paths without crashing.

Crucial design rule: implementations MUST never raise on send. They
return `NotifyResult(ok, message_id?, error?)` and let the caller
decide how to handle failure (retry, ignore, surface to user). A
notification failure should never bring down a task or an HTTP
response.

Channels are independent: a provider may implement only some.
`is_enabled()` per channel lets callers degrade gracefully — e.g.
fall back from SMS to email if SMS isn't configured.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Literal


Channel = Literal["mail", "sms", "push", "voice"]


@dataclass(slots=True)
class NotifyResult:
    """What a send attempt returned. `ok=False` is informational, not raised."""
    ok:          bool
    channel:     Channel
    message_id:  str | None = None
    error:       str | None = None
    detail:      dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class MailMessage:
    to:        list[str]                  # one or more recipient addresses
    subject:   str
    body_text: str                        # plain-text body (always required)
    body_html: str | None = None          # optional HTML, providers fall back to text
    from_addr: str | None = None          # provider default if None
    reply_to:  str | None = None
    tags:      list[str] = field(default_factory=list)


@dataclass(slots=True)
class SmsMessage:
    to:   str                             # E.164 phone number
    body: str                             # ≤ 320 chars recommended


@dataclass(slots=True)
class PushMessage:
    """Web push / native push payload.

    `target` is whatever the provider needs — for web push, the user's
    PushSubscription as a dict; for CronTech native push (when shipped),
    likely a device id / topic. We pass it through without interpretation.
    """
    target:    dict[str, str]
    title:     str
    body:      str
    url:       str | None = None
    tag:       str | None = None


class NotifyProvider(ABC):
    """Outbound transactional notification provider.

    Implementations:
      - log       — logs to stderr (default; safe everywhere)
      - crontech  — placeholder until specs land
      - (future)  — adapt to whatever CronTech ships
    """

    name: str = "abstract"

    @abstractmethod
    def is_enabled(self, channel: Channel) -> bool: ...

    @abstractmethod
    async def send_mail(self, message: MailMessage) -> NotifyResult: ...

    @abstractmethod
    async def send_sms(self, message: SmsMessage) -> NotifyResult: ...

    @abstractmethod
    async def send_push(self, message: PushMessage) -> NotifyResult: ...
