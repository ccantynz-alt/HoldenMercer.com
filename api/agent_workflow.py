"""
Holden Mercer — background-agent workflow assets.

`setup_task_workflow` writes two files to the user's repo:

  .github/workflows/holden-mercer-task.yml   — the workflow that runs the agent
  .holdenmercer/agent_runner.py              — the agent script itself

When the dashboard dispatches the workflow with a `prompt` input, the
workflow runs `agent_runner.py` which executes a Claude tool-use loop
against the project's repo and writes its result to
`.holdenmercer/tasks/<task_id>.md`.

The runner script is read fresh from agent/runner.py at install-time so
new projects always get the latest version. Re-running the setup tool
overwrites both files with the current shipped versions.
"""

from __future__ import annotations

from pathlib import Path

# Read the canonical runner from disk so this module stays the single source
# of truth for what gets written into the user's repo.
_AGENT_RUNNER_PATH = Path(__file__).parent.parent / "agent" / "runner.py"
AGENT_RUNNER_SOURCE = _AGENT_RUNNER_PATH.read_text(encoding="utf-8")

TASK_WORKFLOW_PATH       = ".github/workflows/holden-mercer-task.yml"
TASK_WORKFLOW_FILENAME   = "holden-mercer-task.yml"
RUNNER_PATH              = ".holdenmercer/agent_runner.py"

TASK_WORKFLOW_YAML: str = '''\
name: Holden Mercer — Background Task

# Centralized agent workflow. ONE secret on the HM repo, every project repo
# works automatically. Dispatched from the dashboard with a target_repo input
# pointing at whichever project the task should run against.
#
# Backward-compat: if target_repo is empty, defaults to github.repository
# (works for self-repair tasks dispatched against this repo). Cross-repo
# tasks need HM_PAT (a personal access token with `repo` + `workflow` scopes
# stored as a repo secret); single-repo / self-repair falls back to the
# auto-provided GITHUB_TOKEN.
on:
  workflow_dispatch:
    inputs:
      task_id:
        description: "Opaque task id from the dashboard."
        required: true
      prompt:
        description: "The task for Claude to perform."
        required: true
      target_repo:
        description: "owner/name of the repo this task should operate on. Empty = this repo."
        required: false
        default: ""
      brief:
        description: "Project brief for system context."
        required: false
        default: ""
      model:
        description: "Anthropic model id."
        required: false
        default: "claude-haiku-4-5-20251001"
      max_iters:
        description: "Safety cap on tool-use turns."
        required: false
        default: "30"
      branch:
        description: "Branch to commit to. Empty = repo default."
        required: false
        default: ""

permissions:
  # Need write so the agent can commit files via the GitHub API (same-repo).
  contents: write
  # Need actions:write so the agent can dispatch the gate workflow.
  actions:  write

jobs:
  agent:
    name: Holden Mercer agent
    runs-on: ubuntu-latest
    timeout-minutes: 360

    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

      - uses: actions/setup-python@0b93645e9fea7318ecaed2b359559ac225c90a2b  # v5.3.0
        with:
          python-version: '3.11'

      - name: Install agent deps
        run: pip install -q anthropic httpx

      # SECURITY: stage user-controlled inputs to a JSON file in a step that
      # has NO access to secrets. The next step has secrets but only reads
      # the staged file, so even a malicious prompt can't exfiltrate the
      # API key via shell injection.
      - name: Stage task inputs (no secrets here)
        env:
          HM_REPO:        ${{ github.event.inputs.target_repo != '' && github.event.inputs.target_repo || github.repository }}
          HM_TASK_ID:     ${{ github.event.inputs.task_id }}
          HM_PROMPT:      ${{ github.event.inputs.prompt }}
          HM_BRIEF:       ${{ github.event.inputs.brief }}
          HM_MODEL:       ${{ github.event.inputs.model }}
          HM_MAX_ITERS:   ${{ github.event.inputs.max_iters }}
          HM_BRANCH:      ${{ github.event.inputs.branch }}
        run: |
          mkdir -p /tmp/hm
          python -c "import json,os; json.dump({k: os.environ.get(k,'') for k in ['HM_REPO','HM_TASK_ID','HM_PROMPT','HM_BRIEF','HM_MODEL','HM_MAX_ITERS','HM_BRANCH']}, open('/tmp/hm/inputs.json','w'))"
          chmod 600 /tmp/hm/inputs.json

      - name: Run the agent (secrets, no user input here)
        env:
          HM_INPUTS_FILE:    /tmp/hm/inputs.json
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # Prefer HM_PAT (cross-repo PAT) when set, else the auto GITHUB_TOKEN
          # (works for same-repo only).
          GITHUB_TOKEN:      ${{ secrets.HM_PAT != '' && secrets.HM_PAT || secrets.GITHUB_TOKEN }}
        run: python .holdenmercer/agent_runner.py
'''
