#!/usr/bin/env bash
# Deploy central dashboard after git pull (uses docker-compose.yml in repo root).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/docker-compose.yml}"
HEALTH_URL="${HEALTH_URL:-http://localhost:8080/api/health}"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing compose file: $COMPOSE_FILE"
  exit 1
fi

echo "==> Repo:    $REPO_ROOT ($(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?'))"
echo "==> Compose: $COMPOSE_FILE"

cd "$REPO_ROOT"
docker compose -f "$(basename "$COMPOSE_FILE")" up -d --build --force-recreate dashboard

echo "==> Waiting for health ($HEALTH_URL)..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    curl -s "$HEALTH_URL"
    echo ""
    echo "Done. Hard-refresh the browser (Ctrl+Shift+R)."
    exit 0
  fi
  if [[ "$HEALTH_URL" == *":8080"* ]] && curl -sf "http://localhost:3000/api/health" >/dev/null 2>&1; then
    curl -s "http://localhost:3000/api/health"
    echo ""
    echo "Done (dashboard on port 3000). Hard-refresh the browser (Ctrl+Shift+R)."
    exit 0
  fi
  sleep 2
done

echo "Health check failed — see: docker logs central-dashboard --tail 30"
exit 1
