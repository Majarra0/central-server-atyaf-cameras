#!/usr/bin/env bash
# Deploy central dashboard after git pull.
# Uses docker-compose.remote.yml in picture-upload/frp (bind-mounts this repo).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$HOME/frigate/picture-upload/frp/docker-compose.remote.yml}"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Compose file not found: $COMPOSE_FILE"
  echo "Set COMPOSE_FILE=... or install frp compose next to picture-upload."
  exit 1
fi

echo "==> Repo: $REPO_ROOT ($(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?'))"
echo "==> Compose: $COMPOSE_FILE"

cd "$(dirname "$COMPOSE_FILE")"
docker compose -f "$(basename "$COMPOSE_FILE")" up -d --force-recreate dashboard

echo "==> Waiting for health..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf http://localhost:8080/api/health >/dev/null 2>&1; then
  curl -s http://localhost:8080/api/health
  echo ""
  echo "Done. Open http://localhost:8080 and hard-refresh (Ctrl+Shift+R)."
  exit 0
  fi
  sleep 2
done

echo "Health check failed — see: docker logs central-dashboard --tail 30"
exit 1
