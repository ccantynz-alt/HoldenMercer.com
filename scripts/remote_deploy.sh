#!/usr/bin/env bash
# Sovereign AI Remote Deployer v1.1
# Usage: ./scripts/remote_deploy.sh [VPS_IP] [DOMAIN]
set -euo pipefail

SERVER_IP="${1:-${SOVEREIGN_VPS_IP:-}}"
DOMAIN="${2:-holdenmercer.com}"
REMOTE_DIR="/opt/sovereign-ai"
TUNNEL_NAME="sovereign-tunnel"

if [[ -z "$SERVER_IP" ]]; then
  echo "Usage: $0 <VPS_IP> [domain]"
  echo "       or set SOVEREIGN_VPS_IP in your environment"
  exit 1
fi

# Confirm before pushing to production
if [[ "${DOMAIN}" != *"localhost"* ]]; then
  read -rp "Deploy to https://${DOMAIN} on ${SERVER_IP}? [y/N] " confirm
  [[ "${confirm,,}" == "y" ]] || { echo "Aborted."; exit 0; }
fi

echo "==> Syncing files to ${SERVER_IP}:${REMOTE_DIR} …"
rsync -az --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='__pycache__/' \
  --exclude='.venv/' \
  --exclude='frontend/dist/' \
  --exclude='*.pyc' \
  --exclude='.env' \
  . "root@${SERVER_IP}:${REMOTE_DIR}/"

echo "==> Running remote setup …"
# shellcheck disable=SC2087
ssh "root@${SERVER_IP}" bash <<REMOTE
set -euo pipefail
cd "${REMOTE_DIR}"

# ── Docker ───────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "Installing Docker …"
  curl -fsSL https://get.docker.com | sh
fi

# ── .env guard ───────────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  echo "ERROR: .env not found at ${REMOTE_DIR}/.env"
  echo "Copy your .env to the server first:"
  echo "  scp .env root@${SERVER_IP}:${REMOTE_DIR}/.env"
  exit 1
fi

# ── Build & (re)start container ───────────────────────────────────────────────
echo "Building and starting container …"
docker compose pull --ignore-buildable 2>/dev/null || true
docker compose up -d --build --remove-orphans

# ── Cloudflare Tunnel ─────────────────────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
  echo "Installing cloudflared …"
  wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  dpkg -i cloudflared-linux-amd64.deb
  rm cloudflared-linux-amd64.deb
fi

# Create tunnel if it doesn't exist yet
if ! cloudflared tunnel list 2>/dev/null | grep -q "${TUNNEL_NAME}"; then
  echo "Creating tunnel '${TUNNEL_NAME}' …"
  cloudflared tunnel create "${TUNNEL_NAME}"
fi

# Write tunnel config (idempotent)
TUNNEL_ID=\$(cloudflared tunnel list --output json 2>/dev/null \
  | python3 -c "import sys,json; t=[x for x in json.load(sys.stdin) if x['name']=='${TUNNEL_NAME}']; print(t[0]['id'] if t else '')")

if [[ -n "\${TUNNEL_ID}" ]]; then
  mkdir -p /etc/cloudflared
  cat > /etc/cloudflared/config.yml <<CFCFG
tunnel: \${TUNNEL_ID}
credentials-file: /root/.cloudflared/\${TUNNEL_ID}.json

ingress:
  - hostname: ${DOMAIN}
    service: http://localhost:8000
  - service: http_status:404
CFCFG

  # Route DNS (safe to re-run)
  cloudflared tunnel route dns "${TUNNEL_NAME}" "${DOMAIN}" 2>/dev/null || true

  # Install as systemd service if not already running
  if ! systemctl is-active --quiet cloudflared; then
    cloudflared service install
    systemctl enable --now cloudflared
  else
    systemctl restart cloudflared
  fi
  echo "Tunnel running → https://${DOMAIN}"
else
  echo "WARNING: Could not resolve tunnel ID. Run 'cloudflared login' on the server."
fi

# ── Health check ─────────────────────────────────────────────────────────────
echo -n "Waiting for service to be healthy …"
for i in \$(seq 1 12); do
  if curl -sf http://localhost:8000/health &>/dev/null; then
    echo " OK"
    break
  fi
  echo -n "."
  sleep 5
done
REMOTE

echo ""
echo "✅  Fortress is live at https://${DOMAIN}"
echo "    Health: https://${DOMAIN}/health"
echo "    Logs:   ssh root@${SERVER_IP} 'docker compose -f ${REMOTE_DIR}/docker-compose.yml logs -f'"
