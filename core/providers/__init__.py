"""
Provider factory.

`get_code_host()` returns the active CodeHost (where files / branches / PRs
live + which CI runs them). `get_notify_provider()` returns the active
NotifyProvider (mail / sms / push).

CODE_HOST options:        github (default) · gluecron
NOTIFY_PROVIDER options:  log (default)    · crontech (stub until specs land)

To add a provider: drop a module under core/providers/ + add a branch in
the factory below + flip the env var.
"""

from __future__ import annotations

from functools import lru_cache

from .base import CodeHost
from .github import GitHubCodeHost
from .notify import NotifyProvider


@lru_cache(maxsize=4)
def get_code_host(name: str | None = None) -> CodeHost:
    """Return the active CodeHost. Cached by name so repeated calls are free."""
    if not name:
        from core.config import get_settings
        name = (get_settings().code_host or "github").lower()

    if name == "github":
        return GitHubCodeHost()
    if name == "gluecron":
        from .gluecron import GlueCronCodeHost
        return GlueCronCodeHost()
    # Add future providers here.

    raise ValueError(
        f"Unknown CODE_HOST={name!r}. Supported: github, gluecron. "
        "Add a provider module under core/providers/ + a factory branch."
    )


@lru_cache(maxsize=4)
def get_notify_provider(name: str | None = None) -> NotifyProvider:
    """Return the active NotifyProvider. Default: log (no real send)."""
    if not name:
        from core.config import get_settings
        name = (get_settings().notify_provider or "log").lower()

    if name == "log":
        from .notify_log import NotifyLog
        return NotifyLog()
    if name == "crontech":
        from .notify_crontech import NotifyCronTech
        return NotifyCronTech()

    raise ValueError(
        f"Unknown NOTIFY_PROVIDER={name!r}. Supported: log, crontech."
    )


__all__ = [
    "CodeHost",
    "GitHubCodeHost",
    "NotifyProvider",
    "get_code_host",
    "get_notify_provider",
]
