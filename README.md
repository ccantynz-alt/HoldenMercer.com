# HoldenMercer.com

A voice-first writing surface and command center. Streaming dictation,
style-aware polish, and agentic execution wired so a sentence can travel
from your voice to a pull request without touching a keyboard.

## What's in here

```
frontend/         Vite + React SPA — Landing, Dictation Studio, Voice Engine,
                  Command Center, Task Swarm, System Health
api/              FastAPI app — gateway, command, refine, dictation, infra,
                  voice config, health, providers
core/             Settings, resiliency (Anthropic + Bedrock failover), auth
services/         Executor, refiner, memory, GlueCron + CronTech bridge
migrations/       Supabase pgvector schema for GlueCron embeddings
tests/            pytest — security, resiliency, gateway, dictation polish
scripts/          One-shot deploy + tunnel helpers
Dockerfile        Multi-stage prod build (Node → Python + gunicorn)
vercel.json       Static SPA + serverless FastAPI stopgap
```

## Local development

### Backend

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env       # fill in keys
uvicorn api.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev                # http://localhost:5173
```

The frontend talks to the backend on `http://localhost:8000`. The Liquid
Orb standalone page is served at `/orb.html`.

### Tests

```bash
pytest tests/ -v           # 37 backend tests
cd frontend && npm test    # vitest unit tests for smartFormat, voiceCommands, export
```

## Required environment

Minimum keys to boot a useful instance:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude (refine, command, polish) |
| `DEEPGRAM_API_KEY` | Voice provider (default — set `INFRA_MODE=CRONTECH` to switch) |
| `OPENAI_API_KEY` | Embeddings for GlueCron semantic search |
| `SUPABASE_URL` / `SUPABASE_KEY` | pgvector store for GlueCron memory |
| `GLUECRON_GITHUB_TOKEN` / `GLUECRON_GITHUB_ORG` | Repo access for native memory |
| `SOVEREIGN_API_KEY` | Server auth (omit only in dev) |
| `CRONTECH_API_URL` / `CRONTECH_API_KEY` | Once CronTech is live |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | Bedrock failover (optional) |

## Deployment

### Vercel (current)

The repo deploys to Vercel as a static SPA plus a serverless FastAPI
function (`api/index.py`). WebSocket and Batch endpoints are intentionally
omitted because Vercel functions can't hold long-lived connections — the
frontend streams to Deepgram directly.

```
vercel --prod
```

Routes are defined in `vercel.json`: `/api/*` and `/health` go to the
FastAPI function, everything else falls through to the SPA.

### Docker (full stack)

```bash
docker build -t holdenmercer .
docker run -p 8000:8000 --env-file .env holdenmercer
```

Hits `/health` for liveness; gunicorn runs four uvicorn workers behind a
120s timeout.

## Architecture notes

- **Voice**: Deepgram nova-2 over WebSocket with 300 ms endpointing. The
  `INFRA_MODE` flag switches the provider to CronTech without changing the
  frontend contract.
- **Refinement**: Haiku 4.5 with prompt caching, style-aware (Professional,
  Casual, Academic, Creative, Technical).
- **Execution**: Opus 4.7 with extended thinking + tool use. Power User
  toggle routes commands to the agentic engine; the rest queue to the
  Anthropic Batch API for overnight runs.
- **Memory**: GlueCron — your GitHub repos *are* the database. Files are
  embedded with `text-embedding-3-small` and indexed in Supabase pgvector.
- **Resilience**: Bedrock failover on Anthropic 5xx; Redis-backed Celery
  queue for long jobs.

## Outstanding work

| Item | Where | Blocker |
| --- | --- | --- |
| Real CronTech voice WebSocket path + params | `api/providers/crontech.py` | Awaiting CronTech API spec |
| Real CronTech deployment endpoints | `services/infra_bridge.py:165` | Awaiting CronTech API spec |
| Replace Vercel stopgap with primary backend host | `api/index.py` | Pending CronTech go-live |

The Vercel deploy is sturdy enough to serve as production until then.

## License

Private — © Holden Mercer.
