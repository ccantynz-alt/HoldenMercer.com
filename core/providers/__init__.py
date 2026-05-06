"""
Provider factory.

`get_code_host()` returns the active CodeHost — where files / branches / PRs
live and which CI runs them.

CODE_HOST options: github (default) · gluecron

To add a provider: drop a module under core/providers/ + add a branch in
the factory below + flip the env var.
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
    if name == "gluecron":
        from .gluecron import GlueCronCodeHost
        return GlueCronCodeHost()
    # Add future providers here.

    raise ValueError(
        f"Unknown CODE_HOST={name!r}. Supported: github, gluecron. "
        "Add a provider module under core/providers/ + a factory branch."
    )


__all__ = ["CodeHost", "GitHubCodeHost", "get_code_host"]
