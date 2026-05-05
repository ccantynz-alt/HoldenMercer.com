"""
GitHub adapter — implements `CodeHost` against api.github.com.

This is currently the only provider. It DELEGATES to the existing
implementations in `api/console_tools.py`, `api/gate_tools.py`, and
`api/jobs.py` so this PR introduces zero behavior change.

Future work (when GlueCron specs are available):
  • Move the canonical implementations from console_tools.py into this file
  • Write `core/providers/gluecron.py` implementing the same interface
  • Flip CODE_HOST=gluecron in env to switch
  • Console / Gate / Tasks / Cron all keep working untouched
"""

from __future__ import annotations

from typing import Any

from .base import CodeHost


class GitHubCodeHost(CodeHost):
    name = "github"

    # ── Files / branches / PRs ─────────────────────────────────────────────

    async def get_file(self, repo: str, path: str, ref: str | None, token: str) -> str:
        from api.console_tools import _read_github_file
        return await _read_github_file(repo, path, ref, token)

    async def put_file(
        self, repo: str, path: str, content: str,
        commit_message: str, branch: str | None, token: str,
    ) -> str:
        from api.console_tools import _write_github_file
        return await _write_github_file(
            repo=repo, path=path, content=content,
            commit_message=commit_message, branch=branch, token=token,
        )

    async def delete_file(
        self, repo: str, path: str, commit_message: str,
        branch: str | None, token: str,
    ) -> str:
        from api.console_tools import _delete_github_file
        return await _delete_github_file(
            repo=repo, path=path, commit_message=commit_message,
            branch=branch, token=token,
        )

    async def list_dir(
        self, repo: str, path: str, ref: str | None, token: str,
    ) -> list[dict]:
        from api.console_tools import _fetch_github_dir
        return await _fetch_github_dir(repo, path, ref, token)

    async def list_repos(self, org: str, token: str) -> list[dict]:
        from api.console_tools import _fetch_github_repos
        return await _fetch_github_repos(token, org)

    async def default_branch(self, repo: str, token: str) -> str:
        import httpx
        from api.console_tools import GITHUB_API, _gh_headers
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(f"{GITHUB_API}/repos/{repo}", headers=_gh_headers(token))
            r.raise_for_status()
            return r.json().get("default_branch", "main")

    async def create_branch(
        self, repo: str, branch: str, from_ref: str | None, token: str,
    ) -> str:
        from api.console_tools import _create_github_branch
        return await _create_github_branch(repo, branch, from_ref, token)

    async def commit_changes(
        self, repo: str, files: list[dict], commit_message: str,
        branch: str | None, token: str,
    ) -> str:
        from api.console_tools import _commit_changes
        return await _commit_changes(
            repo=repo, files=files, commit_message=commit_message,
            branch=branch, token=token,
        )

    async def open_pull_request(
        self, repo: str, head: str, base: str | None,
        title: str, body: str, token: str,
    ) -> str:
        from api.console_tools import _open_pull_request
        return await _open_pull_request(
            repo=repo, head=head, base=base, title=title, body=body, token=token,
        )

    async def merge_pull_request(
        self, repo: str, pull_number: int, merge_method: str, token: str,
    ) -> str:
        from api.console_tools import _merge_pull_request
        return await _merge_pull_request(
            repo=repo, pull_number=pull_number,
            merge_method=merge_method, token=token,
        )

    async def search_code(self, repo: str, query: str, token: str) -> str:
        from api.console_tools import _search_repo_code
        return await _search_repo_code(repo, query, token)

    # ── CI / workflows ────────────────────────────────────────────────────

    async def install_workflow(
        self, repo: str, filename: str, content: str,
        branch: str | None, token: str,
    ) -> str:
        # GitHub workflows live under .github/workflows/<filename>
        return await self.put_file(
            repo=repo, path=f".github/workflows/{filename}",
            content=content,
            commit_message=f"chore(workflow): install {filename}",
            branch=branch, token=token,
        )

    async def dispatch_workflow(
        self, repo: str, filename: str, ref: str,
        inputs: dict[str, str], token: str,
    ) -> str:
        import httpx
        from api.console_tools import GITHUB_API, _gh_headers
        url = f"{GITHUB_API}/repos/{repo}/actions/workflows/{filename}/dispatches"
        body: dict[str, Any] = {"ref": ref}
        if inputs:
            body["inputs"] = inputs
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(url, headers=_gh_headers(token), json=body)
        if r.status_code == 404:
            return f"[workflow not installed: {filename}]"
        if r.status_code >= 400:
            return f"[dispatch failed: {r.status_code} {r.text[:300]}]"
        return f"dispatched {filename} on {ref}"

    async def list_workflow_runs(
        self, repo: str, filename: str, params: dict | None, token: str,
    ) -> dict:
        import httpx
        from api.console_tools import GITHUB_API, _gh_headers
        url = f"{GITHUB_API}/repos/{repo}/actions/workflows/{filename}/runs"
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(url, headers=_gh_headers(token), params=params or {})
        if r.status_code == 404:
            return {"workflow_installed": False, "workflow_runs": []}
        r.raise_for_status()
        data = r.json()
        data.setdefault("workflow_installed", True)
        return data

    async def get_workflow_run(self, repo: str, run_id: int | str, token: str) -> dict | None:
        import httpx
        from api.console_tools import GITHUB_API, _gh_headers
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(
                f"{GITHUB_API}/repos/{repo}/actions/runs/{run_id}",
                headers=_gh_headers(token),
            )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    async def get_workflow_logs(self, repo: str, run_id: int | str, token: str) -> str:
        from api.gate_tools import _read_gate_logs
        # Gate-logs implementation handles the zip extract; reuse it. (When
        # we generalise to non-gate runs we'll lift that helper.)
        return await _read_gate_logs(repo, run_id, token)

    async def latest_run_for_sha(
        self, repo: str, filename: str, head_sha: str, token: str,
    ) -> dict | None:
        data = await self.list_workflow_runs(
            repo, filename, {"head_sha": head_sha, "per_page": 1}, token,
        )
        runs = data.get("workflow_runs") or []
        return runs[0] if runs else None

    # ── Provider deep-links ───────────────────────────────────────────────

    def secrets_setup_url(self, repo: str) -> str:
        return f"https://github.com/{repo}/settings/secrets/actions/new"
