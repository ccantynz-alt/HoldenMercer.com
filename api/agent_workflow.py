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

# Dispatched from the dashboard with a task prompt. Runs a Claude tool-use
# loop in this repo for up to 6 hours, writes its result to
# .holdenmercer/tasks/<task_id>.md, and commits its work along the way.
on:
  workflow_dispatch:
    inputs:
      task_id:
        description: "Opaque task id from the dashboard."
        required: true
      prompt:
        description: "The task for Claude to perform."
        required: true
      brief:
        description: "Project brief for system context."
        required: false
        default: ""
      model:
        description: "Anthropic model id."
        required: false
        default: "claude-opus-4-7"
      max_iters:
        description: "Safety cap on tool-use turns."
        required: false
        default: "30"
      branch:
        description: "Branch to commit to. Empty = repo default."
        required: false
        default: ""

permissions:
  # Need write so the agent can commit files via the GitHub API.
  contents: write
  # Need actions:write so the agent can dispatch the gate workflow.
  actions:  write

jobs:
  agent:
    name: Holden Mercer agent
    runs-on: ubuntu-latest
    timeout-minutes: 360

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install agent deps
        run: pip install -q anthropic httpx

      - name: Run the agent
        env:
          HM_REPO:           ${{ github.repository }}
          HM_TASK_ID:        ${{ github.event.inputs.task_id }}
          HM_PROMPT:         ${{ github.event.inputs.prompt }}
          HM_BRIEF:          ${{ github.event.inputs.brief }}
          HM_MODEL:          ${{ github.event.inputs.model }}
          HM_MAX_ITERS:      ${{ github.event.inputs.max_iters }}
          HM_BRANCH:         ${{ github.event.inputs.branch }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN:      ${{ secrets.GITHUB_TOKEN }}
        run: python .holdenmercer/agent_runner.py
'''
