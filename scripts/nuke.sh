#!/usr/bin/env bash
# Sovereign AI — Emergency Instance Wipe
# Stops all services and removes runtime secrets from this machine.
# Does NOT touch the VPS. Run remote_nuke.sh to wipe a remote instance.
set -euo pipefail

echo ""
echo "  WARNING: This will stop the container and delete local secrets."
echo "  This action cannot be undone."
echo ""
read -rp "  Type CONFIRM to proceed: " answer
if [[ "${answer}" != "CONFIRM" ]]; then
  echo "Aborted."
  exit 0
fi

# Stop and remove container + anonymous volumes
if docker compose ps --quiet 2>/dev/null | grep -q .; then
  echo "==> Stopping container …"
  docker compose down -v
else
  echo "==> No running container found."
fi

# Remove .env
if [[ -f .env ]]; then
  echo "==> Removing .env …"
  # shred if available (Linux), otherwise plain removal
  if command -v shred &>/dev/null; then
    shred -u .env
  else
    rm -f .env
  fi
fi

# Wipe any local key files
if [[ -d api/keys ]]; then
  echo "==> Shredding api/keys/ …"
  if command -v shred &>/dev/null; then
    find api/keys/ -type f -exec shred -u {} \;
  else
    rm -rf api/keys/
  fi
fi

# Wipe local logs
if [[ -d api/logs ]]; then
  echo "==> Removing api/logs/ …"
  rm -rf api/logs/
fi

echo ""
echo "Done. Secrets removed. Container stopped."
echo "To redeploy: cp .env.example .env && vim .env && ./scripts/remote_deploy.sh"
