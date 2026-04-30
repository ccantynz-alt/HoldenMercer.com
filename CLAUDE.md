# HoldenMercer.com — operating rules

## Mandate: finish the work, don't ask

When the user asks for something that obviously has to be done to ship (build
fixes, wiring up stubbed endpoints, replacing temporary stopgaps, plumbing
config, finishing a redesign across the app, etc.), **do not stop mid-task to
ask whether to continue**. Push through to a working, deployable state, then
report what shipped and what's still genuinely blocked on external input.

Specifically:
- Don't ask "want me to keep going?" when the answer is obviously yes — keep
  going.
- Don't pause after a partial sweep ("I changed the tokens, want me to do the
  pages too?"). Sweep the whole thing.
- Only stop early if you hit a real blocker: missing credentials, ambiguous
  product decisions, a destructive action, or external info the user has to
  provide (e.g. a third-party API spec that isn't in the repo).
- When you do stop, be explicit about *why* — name the blocker, don't disguise
  a check-in as a blocker.

The goal is a finished, working site. Needle-tweak passes on colour and copy
come later.

## Project shape

- **Frontend**: Vite + React under `frontend/`. `npm run build` is the gate.
- **Backend**: FastAPI under `api/` + `services/`. Tests under `tests/`.
- **Stopgaps to retire** (search the code for `stopgap` and `TODO`):
  - `api/index.py` — Vercel serverless wrapper around FastAPI, temporary.
  - `api/providers/crontech.py`, `services/infra_bridge.py` — placeholder
    endpoints awaiting the real CronTech API spec.

## Branching

All development for this session goes on
`claude/website-redesign-colors-PsGV9`. Push there. Never push to `main`
without explicit approval.
