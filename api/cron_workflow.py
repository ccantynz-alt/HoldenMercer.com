"""
Holden Mercer — cron workflow assets.

`setup_cron_workflow` writes three files to the user's repo:

  .github/workflows/holden-mercer-cron.yml   — runs every 15 min, dispatches
                                                 schedules that fire in window
  .holdenmercer/cron_runner.py               — the evaluator script
  .holdenmercer/schedules.yml (sample)       — only created if not present;
                                                 user (or Claude) edits this

The workflow needs `actions:write` permission so it can dispatch the task
workflow. It uses `secrets.GITHUB_TOKEN`, no extra secrets to set up.
"""

from __future__ import annotations

from pathlib import Path

_CRON_RUNNER_PATH = Path(__file__).parent.parent / "agent" / "cron_runner.py"
CRON_RUNNER_SOURCE = _CRON_RUNNER_PATH.read_text(encoding="utf-8")

CRON_WORKFLOW_PATH      = ".github/workflows/holden-mercer-cron.yml"
CRON_RUNNER_REPO_PATH   = ".holdenmercer/cron_runner.py"
SCHEDULES_FILE_PATH     = ".holdenmercer/schedules.yml"

CRON_WORKFLOW_YAML: str = '''\
name: Holden Mercer — Cron

# Runs every 15 minutes (UTC). Reads .holdenmercer/schedules.yml and dispatches
# any scheduled task whose cron expression fires in the last 15 minutes.
#
# To stop scheduled runs entirely: comment out the `schedule:` block, or
# delete this workflow file. Individual schedules are managed in schedules.yml.
on:
  workflow_dispatch:    # manual run for testing
  schedule:
    - cron: "*/15 * * * *"

permissions:
  contents: read
  actions:  write       # to dispatch the task workflow

jobs:
  cron:
    name: Evaluate schedules
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

      - uses: actions/setup-python@0b93645e9fea7318ecaed2b359559ac225c90a2b  # v5.3.0
        with:
          python-version: '3.11'

      - name: Install deps
        run: pip install -q httpx pyyaml

      - name: Run cron evaluator
        env:
          HM_REPO:        ${{ github.repository }}
          HM_WINDOW_MIN:  "15"
          GITHUB_TOKEN:   ${{ secrets.GITHUB_TOKEN }}
        run: python .holdenmercer/cron_runner.py
'''

SAMPLE_SCHEDULES_YAML: str = '''\
# Holden Mercer scheduled tasks.
# Each entry dispatches a background task via the holden-mercer-task workflow
# whenever its `when` cron expression fires (UTC, 5-field standard cron).
#
# To remove a schedule: delete its entry. To pause everything: comment out
# the schedule: block in .github/workflows/holden-mercer-cron.yml.
#
# Examples below are commented out. Uncomment + edit, or ask the Console:
# "add a schedule that updates the README every Monday at 9am UTC".

schedules: []

# - id: weekly-readme
#   name: "Refresh README weekly"
#   when: "0 9 * * 1"        # Mondays 09:00 UTC
#   prompt: |
#     Read the last week of commits, rewrite the README's "What's new"
#     section to reflect them, run the gate.
#
# - id: nightly-deps
#   name: "Check for outdated dependencies"
#   when: "0 3 * * *"        # daily 03:00 UTC
#   prompt: |
#     Run npm outdated and pip list --outdated, summarise findings,
#     and propose dependency bumps in a single commit + run the gate.
'''
