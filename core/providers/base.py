"""
CodeHost — provider abstraction for the "GitHub-shaped" operations Holden
Mercer relies on.

The product was built against GitHub directly. We will eventually move to
GlueCron (our own equivalent of GitHub) and CronTech (our equivalent of
Cloudflare / Vercel / Render / Mailgun / Twilio). Rather than scatter
`api.github.com` literals across 18 tool implementations, ALL provider-
specific code lives behind this interface. To swap providers we write a
new adapter (`gluecron.py`, `crontech.py`, …) and flip the `CODE_HOST` env
setting — no churn in the callers.

Operation set, grouped:

  Files / branches / PRs:
    - get_file       (raw bytes / text)
    - put_file       (single-file commit)
    - delete_file
    - list_dir
    - list_repos
    - default_branch
    - create_branch
    - commit_changes (multi-file atomic commit)
    - open_pull_request
    - merge_pull_request   (gate-protected — refuses if no green run)
    - search_code
    - recent_commits
    - open_pulls

  CI / workflows:
    - install_workflow      (writes a workflow file)
    - dispatch_workflow     (workflow_dispatch with inputs)
    - list_workflow_runs
    - get_workflow_run
    - get_workflow_logs
    - latest_run_for_sha    (used by merge gate-check)

  Repo metadata:
    - get_repo
    - secrets_setup_url     (provider-specific deep link for adding API keys)

The default v1 GitHub adapter (`core/providers/github.py`) wraps the
existing implementations in `api/console_tools.py`, `api/gate_tools.py`,
and `api/jobs.py` so this PR introduces zero behavior change. Future PRs
migrate the call sites to use `get_code_host()` directly.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class CodeHost(ABC):
    """Provider-neutral interface for code-host operations.

    Implementations: GitHub today, GlueCron next, CronTech execution layer
    after that. Add new ones via `core/providers/<name>.py` + a factory
    branch in `core/providers/__init__.py`.
    """

    name: str = "abstract"

    # ── Files / branches / PRs ─────────────────────────────────────────────

    @abstractmethod
    async def get_file(self, repo: str, path: str, ref: str | None, token: str) -> str:
        """Return UTF-8 text content of a file. Returns a `[not found: ...]`
        / `[refused: binary]` / `[refused: too large]` string on miss."""

    @abstractmethod
    async def put_file(
        self, repo: str, path: str, content: str,
        commit_message: str, branch: str | None, token: str,
    ) -> str:
        """Create or overwrite a file in one commit. Returns a human-readable result."""

    @abstractmethod
    async def delete_file(
        self, repo: str, path: str, commit_message: str,
        branch: str | None, token: str,
    ) -> str:
        ...

    @abstractmethod
    async def list_dir(
        self, repo: str, path: str, ref: str | None, token: str,
    ) -> list[dict]:
        """Return raw directory entries (provider-shaped dicts)."""

    @abstractmethod
    async def list_repos(self, org: str, token: str) -> list[dict]:
        """Return raw repo metadata dicts owned by the user/org."""

    @abstractmethod
    async def default_branch(self, repo: str, token: str) -> str: ...

    @abstractmethod
    async def create_branch(
        self, repo: str, branch: str, from_ref: str | None, token: str,
    ) -> str: ...

    @abstractmethod
    async def commit_changes(
        self, repo: str, files: list[dict], commit_message: str,
        branch: str | None, token: str,
    ) -> str: ...

    @abstractmethod
    async def open_pull_request(
        self, repo: str, head: str, base: str | None,
        title: str, body: str, token: str,
    ) -> str: ...

    @abstractmethod
    async def merge_pull_request(
        self, repo: str, pull_number: int, merge_method: str, token: str,
    ) -> str: ...

    @abstractmethod
    async def search_code(self, repo: str, query: str, token: str) -> str: ...

    # ── CI / workflows ────────────────────────────────────────────────────

    @abstractmethod
    async def install_workflow(
        self, repo: str, filename: str, content: str,
        branch: str | None, token: str,
    ) -> str: ...

    @abstractmethod
    async def dispatch_workflow(
        self, repo: str, filename: str, ref: str,
        inputs: dict[str, str], token: str,
    ) -> str: ...

    @abstractmethod
    async def list_workflow_runs(
        self, repo: str, filename: str, params: dict | None, token: str,
    ) -> dict: ...

    @abstractmethod
    async def get_workflow_run(self, repo: str, run_id: int | str, token: str) -> dict | None: ...

    @abstractmethod
    async def get_workflow_logs(self, repo: str, run_id: int | str, token: str) -> str: ...

    @abstractmethod
    async def latest_run_for_sha(
        self, repo: str, filename: str, head_sha: str, token: str,
    ) -> dict | None: ...

    # ── Provider-specific deep-links ──────────────────────────────────────

    def secrets_setup_url(self, repo: str) -> str:
        """Where the user adds API keys for background tasks. GitHub points at
        their repo Secrets page; CronTech / GlueCron will have their own paths."""
        raise NotImplementedError
