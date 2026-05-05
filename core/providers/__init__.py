"""
Provider factory.

`get_code_host()` returns the active CodeHost adapter based on the
`CODE_HOST` env setting. Default: github.

Future providers (write a module + add a branch here):
  CODE_HOST=gluecron  → core/providers/gluecron.py  (our GitHub equivalent)
  CODE_HOST=crontech  → core/providers/crontech.py  (compute / mail / sms)
"""

from __future__ import annotations

from functools import lru_cache

from .base import CodeHost
from .github import GitHubCodeHost


@lru_cache(maxsize=4)
def get_code_host(name: str | None = None) -> CodeHost:
    """Return the active CodeHost. Cached by name so repeated calls are free."""
    if not name:
        from core.config import get_settings
        name = (get_settings().code_host or "github").lower()

    if name == "github":
        return GitHubCodeHost()
    # Add future providers here:
    # if name == "gluecron":
    #     from .gluecron import GlueCronCodeHost
    #     return GlueCronCodeHost()
    # if name == "crontech":
    #     from .crontech import CronTechCodeHost
    #     return CronTechCodeHost()

    raise ValueError(
        f"Unknown CODE_HOST={name!r}. Supported: github. "
        "Add a provider module under core/providers/ + a factory branch."
    )


__all__ = ["CodeHost", "GitHubCodeHost", "get_code_host"]
