# Changelog

All notable changes to Holden Mercer.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Centralized agent dispatch — one `ANTHROPIC_API_KEY` + `HM_PAT` on this repo unlocks every project repo (no per-project secret setup)
- AdminHome **Setup readiness** card with one-click deeplinks to fix missing secrets
- AdminHome **Update central workflow** button (one-click YAML refresh)
- Per-project **ProjectReadiness** banner (Brief / Invariants / Gate / Last run pills)
- **Audit log** tab with cross-project chronological feed + filters (commits / PRs / runs / tasks / crashes)
- **Cmd-K command palette** for global navigation
- **Live task log viewer** (📜 Logs button on each task) — streams GHA logs into the dashboard, auto-refresh every 5s
- Per-task **Cancel** + **🗑** buttons on the Tasks tab
- BYOK API spend tracking (per-day / per-model totals + estimated $ on AdminHome)
- ErrorBoundary with **Hard reset (preserves API keys)** + **Nuclear reset** options
- Per-section error boundaries so one looping component can't blank the dashboard
- `window.__hmLastCrash` + `window.__hmLastWindowError` capture for forensics
- `/api/jobs/check-secret` + `/cancel` + `/delete-run` + `/run-logs` endpoints

### Changed
- Default model is now **Haiku 4.5** (was Opus 4.7) — ~12× cheaper for routine work
- All user-facing copy scrubbed of competitor (GitHub) naming where context permits — neutral "code-host" language
- Self-repair Settings field defaults to `ccantynz-alt/HoldenMercer.com` if empty
- Hard reset preserves Anthropic key, code-host PAT, GitHub username/org, and project list

### Fixed
- React-185 (Maximum update depth) loops in AdminHome / Tasks / Memory / Gate / Console / Planner caused by `useMemo` returning unstable references for async functions used as `useEffect` deps
- Saving a PAT in Settings no longer logs the user out (backend was propagating GitHub 401s as 401 to the SPA)
- Self-repair field accepting full GitHub URLs no longer breaks "Add it →" deeplinks (URL prefix auto-stripped)
- Onboarding a fresh repo no longer requires bouncing to the Tasks tab to install the workflow first (auto-install on first dispatch)

### Security
- All `actions/checkout`, `actions/setup-python`, `actions/setup-node` references pinned to immutable commit SHAs
- Gate workflow has explicit `permissions: read-all` (minimum-privilege default)
- Task workflow stages user inputs to `/tmp/hm/inputs.json` in a step with no secrets, then a separate step with secrets reads the staged file — kills the secret-exfil risk flagged by gatetest.ai's ciHardening check
