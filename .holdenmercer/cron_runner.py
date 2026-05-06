"""
Holden Mercer — cron evaluator.

Runs inside the holden-mercer-cron.yml workflow on a 15-minute cron. Reads
.holdenmercer/schedules.yml from the repo, evaluates each entry's cron
expression against the current UTC time (with a 15-minute window), and
dispatches a background task for each entry that should fire now.

schedules.yml format:

    schedules:
      - id: weekly-readme
        name: "Update README weekly"
        when: "0 9 * * 1"          # cron expression, UTC
        prompt: |
            Read the last week of commits, refresh the README's "What's new"
            section, then run the gate.
        model: claude-opus-4-7      # optional
        max_iters: 30               # optional

The cron expression supports the standard 5-field form
(minute hour day-of-month month day-of-week).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
from typing import Iterable

import httpx
import yaml


REPO          = os.environ["HM_REPO"]
GH_TOKEN      = os.environ["GITHUB_TOKEN"]
WINDOW_MIN    = int(os.environ.get("HM_WINDOW_MIN", "15"))

GH_API     = "https://api.github.com"
GH_HEADERS = {
    "Authorization":         f"Bearer {GH_TOKEN}",
    "Accept":                "application/vnd.github+json",
    "X-GitHub-Api-Version":  "2022-11-28",
    "User-Agent":            "Holden Mercer Cron",
}


# ── Cron parsing ────────────────────────────────────────────────────────────

def _expand_field(field: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
    for chunk in field.split(","):
        step = 1
        if "/" in chunk:
            chunk, step_s = chunk.split("/", 1)
            step = int(step_s)
        if chunk == "*":
            start, end = lo, hi
        elif "-" in chunk:
            a, b = chunk.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(chunk)
        for v in range(start, end + 1, step):
            if lo <= v <= hi:
                out.add(v)
    return out


def cron_matches(expr: str, when: dt.datetime) -> bool:
    parts = expr.strip().split()
    if len(parts) != 5:
        raise ValueError(f"cron expr must be 5 fields, got: {expr!r}")
    minute_set = _expand_field(parts[0], 0, 59)
    hour_set   = _expand_field(parts[1], 0, 23)
    dom_set    = _expand_field(parts[2], 1, 31)
    month_set  = _expand_field(parts[3], 1, 12)
    dow_set    = _expand_field(parts[4], 0, 6)   # 0 = Sunday

    if when.minute not in minute_set: return False
    if when.hour   not in hour_set:   return False
    if when.month  not in month_set:  return False

    # Day matches if EITHER day-of-month or day-of-week matches (cron quirk).
    # Sunday=0 in cron, Monday=1; Python's weekday() is Monday=0..Sunday=6.
    py_dow = (when.weekday() + 1) % 7
    dom_match = when.day in dom_set
    dow_match = py_dow in dow_set
    # If both fields are restricted, OR; if either is "*", AND.
    dom_restricted = parts[2] != "*"
    dow_restricted = parts[4] != "*"
    if dom_restricted and dow_restricted:
        return dom_match or dow_match
    return dom_match and dow_match


def matches_in_window(expr: str, now: dt.datetime, window_min: int) -> bool:
    """True if the cron would have fired any time in [now - window, now]."""
    for offset in range(window_min):
        when = now - dt.timedelta(minutes=offset)
        # zero out seconds; cron runs on minute boundaries
        when = when.replace(second=0, microsecond=0)
        if cron_matches(expr, when):
            return True
    return False


# ── Schedule loading ────────────────────────────────────────────────────────

def load_schedules() -> list[dict]:
    url = f"{GH_API}/repos/{REPO}/contents/.holdenmercer/schedules.yml"
    r = httpx.get(url, headers={**GH_HEADERS, "Accept": "application/vnd.github.raw"}, timeout=20.0)
    if r.status_code == 404:
        print("[no schedules.yml — skipping]")
        return []
    r.raise_for_status()
    data = yaml.safe_load(r.text) or {}
    items = data.get("schedules") or []
    valid = []
    for s in items:
        if not isinstance(s, dict): continue
        if "when" not in s or "prompt" not in s:
            print(f"[skipping invalid schedule: {s!r}]")
            continue
        valid.append(s)
    return valid


# ── Dispatch ────────────────────────────────────────────────────────────────

def new_task_id() -> str:
    import secrets
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{stamp}-cron-{secrets.token_hex(2)}"


def dispatch(schedule: dict) -> None:
    task_id = new_task_id()
    inputs = {
        "task_id":   task_id,
        "prompt":    schedule["prompt"].strip(),
        "brief":     f"Scheduled task: {schedule.get('name', schedule.get('id', 'cron'))}",
        "model":     schedule.get("model", "claude-opus-4-7"),
        "max_iters": str(int(schedule.get("max_iters", 30))),
        "branch":    schedule.get("branch") or "",
    }
    url = f"{GH_API}/repos/{REPO}/actions/workflows/holden-mercer-task.yml/dispatches"
    body = {"ref": schedule.get("branch") or "main", "inputs": inputs}
    r = httpx.post(url, headers=GH_HEADERS, json=body, timeout=20.0)
    if r.status_code == 404:
        print(f"[no task workflow installed — install it via the dashboard first]")
        return
    if r.status_code >= 400:
        print(f"[dispatch error: {r.status_code} {r.text[:200]}]")
        return
    print(f"  ✓ dispatched task_id={task_id} for schedule {schedule.get('id', '<unnamed>')}")


def main() -> int:
    now = dt.datetime.now(dt.timezone.utc)
    print(f"::group::cron tick @ {now.isoformat()} (window={WINDOW_MIN}m)")
    schedules = load_schedules()
    print(f"loaded {len(schedules)} schedule(s)")

    fired = 0
    for s in schedules:
        sid  = s.get("id", "<unnamed>")
        when = s["when"]
        try:
            should_fire = matches_in_window(when, now, WINDOW_MIN)
        except ValueError as exc:
            print(f"  [{sid}] invalid cron: {exc}")
            continue
        if should_fire:
            print(f"  [{sid}] fires now ({when})")
            dispatch(s)
            fired += 1
        else:
            print(f"  [{sid}] not due ({when})")

    print(f"fired {fired} task(s)")
    print("::endgroup::")
    return 0


if __name__ == "__main__":
    sys.exit(main())
