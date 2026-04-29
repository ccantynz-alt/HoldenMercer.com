#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Sovereign Engine — Cloudflare Tunnel Launcher
#
# Usage:
#   bash scripts/start_tunnel.sh              (uses default port 8000)
#   bash scripts/start_tunnel.sh 9000         (custom port)
#
# Prerequisites:
#   1. cloudflared installed:
#        Windows : winget install Cloudflare.cloudflared
#        macOS   : brew install cloudflared
#        Linux   : https://pkg.cloudflare.com/index.html
#   2. The Sovereign Engine must already be running:
#        .venv/Scripts/uvicorn api.main:app --host 127.0.0.1 --port 8000
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PORT="${1:-8000}"
LOCAL_URL="http://127.0.0.1:${PORT}"
LOG_FILE="/tmp/sovereign_cloudflared.log"

# ── Check cloudflared is available ──────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
    echo ""
    echo "  ERROR: 'cloudflared' not found."
    echo ""
    echo "  Install it first:"
    echo "    Windows : winget install Cloudflare.cloudflared"
    echo "    macOS   : brew install cloudflared"
    echo "    Linux   : https://pkg.cloudflare.com/index.html"
    echo ""
    exit 1
fi

# ── Check the local server is reachable ─────────────────────────────────────
if ! curl -sf "${LOCAL_URL}/health" >/dev/null 2>&1; then
    echo ""
    echo "  WARNING: Sovereign Engine not responding at ${LOCAL_URL}/health"
    echo "  Start it first in another terminal:"
    echo ""
    echo "    .venv/Scripts/uvicorn api.main:app --host 127.0.0.1 --port ${PORT} --reload"
    echo ""
    read -rp "  Continue anyway? [y/N] " confirm
    [[ "${confirm,,}" == "y" ]] || exit 1
fi

# ── Launch tunnel ────────────────────────────────────────────────────────────
echo ""
echo "  Starting Cloudflare tunnel → ${LOCAL_URL} ..."
rm -f "${LOG_FILE}"

cloudflared tunnel --url "${LOCAL_URL}" \
    --no-autoupdate \
    2>&1 | tee "${LOG_FILE}" &

TUNNEL_PID=$!

# ── Wait for public URL to appear in logs ────────────────────────────────────
echo "  Waiting for tunnel URL (this takes ~5 seconds)..."
TUNNEL_URL=""
for i in $(seq 1 30); do
    sleep 1
    TUNNEL_URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "${LOG_FILE}" 2>/dev/null | head -1 || true)
    if [[ -n "${TUNNEL_URL}" ]]; then
        break
    fi
done

if [[ -z "${TUNNEL_URL}" ]]; then
    echo ""
    echo "  ERROR: Tunnel URL did not appear after 30 seconds."
    echo "  Check ${LOG_FILE} for errors."
    kill "${TUNNEL_PID}" 2>/dev/null || true
    exit 1
fi

# ── Read API key from .env (optional display) ────────────────────────────────
SOVEREIGN_API_KEY=""
if [[ -f ".env" ]]; then
    SOVEREIGN_API_KEY=$(grep -E "^SOVEREIGN_API_KEY=" .env | cut -d'=' -f2- | tr -d '[:space:]' || true)
fi

KEY_HINT="${SOVEREIGN_API_KEY:-<your SOVEREIGN_API_KEY from .env>}"

# ── Print connection instructions ─────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║          SOVEREIGN ENGINE — TUNNEL ACTIVE                       ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║                                                                  ║"
echo "║  STEP 1 — Paste this URL into Voxlen.ai webhook settings:       ║"
echo "║                                                                  ║"
printf  "║  %-64s║\n"  "  ${TUNNEL_URL}/api/voxlen-ingest"
echo "║                                                                  ║"
echo "║  STEP 2 — Add this custom header in Voxlen.ai:                  ║"
echo "║                                                                  ║"
echo "║    Header name  :  X-Sovereign-Key                              ║"
printf  "║    Header value :  %-46s║\n"  "${KEY_HINT}"
echo "║                                                                  ║"
echo "║  STEP 3 — Set webhook method to POST, content-type JSON.        ║"
echo "║                                                                  ║"
echo "║  Health check (no key needed):                                  ║"
printf  "║    %-62s  ║\n"  "  ${TUNNEL_URL}/health"
echo "║                                                                  ║"
echo "║  Tunnel PID: ${TUNNEL_PID}  •  Logs: ${LOG_FILE}"
echo "║  Press Ctrl-C to stop.                                          ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# ── Keep script alive so Ctrl-C kills the tunnel cleanly ────────────────────
trap "echo ''; echo '  Tunnel stopped.'; kill ${TUNNEL_PID} 2>/dev/null; exit 0" INT TERM
wait "${TUNNEL_PID}"
