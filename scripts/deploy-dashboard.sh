#!/usr/bin/env bash
# Deploy central dashboard after git pull.
#
# Usage:
#   ./scripts/deploy-dashboard.sh
#   ./scripts/deploy-dashboard.sh /path/to/docker-compose.yml
#   COMPOSE_FILE=/path/to/docker-compose.yml ./scripts/deploy-dashboard.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HEALTH_URL="${HEALTH_URL:-http://localhost:8080/api/health}"

find_compose_file() {
  if [[ -n "${COMPOSE_FILE:-}" && -f "$COMPOSE_FILE" ]]; then
    echo "$COMPOSE_FILE"
    return 0
  fi
  if [[ -n "${1:-}" && -f "$1" ]]; then
    echo "$1"
    return 0
  fi

  local candidates=(
    "$REPO_ROOT/docker-compose.yml"
    "$HOME/frigate/picture-upload/frp/docker-compose.yml"
    "$HOME/frigate/picture-upload/frp/docker-compose.remote.yml"
    "$REPO_ROOT/../frigate/picture-upload/frp/docker-compose.yml"
  )

  local f
  for f in "${candidates[@]}"; do
    if [[ -f "$f" ]]; then
      echo "$f"
      return 0
    fi
  done
  return 1
}

COMPOSE_FILE="$(find_compose_file "${1:-}")" || {
  echo "No compose file found. Tried:"
  echo "  $REPO_ROOT/docker-compose.yml"
  echo "  ~/frigate/picture-upload/frp/docker-compose.yml"
  echo ""
  echo "Pass the path explicitly:"
  echo "  ./scripts/deploy-dashboard.sh ~/frigate/picture-upload/frp/docker-compose.yml"
  echo "  COMPOSE_FILE=... ./scripts/deploy-dashboard.sh"
  exit 1
}

echo "==> Repo:    $REPO_ROOT ($(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?'))"
echo "==> Compose: $COMPOSE_FILE"

cd "$(dirname "$COMPOSE_FILE")"
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
    HEALTH_URL="http://localhost:3000/api/health"
    curl -s "$HEALTH_URL"
    echo ""
    echo "Done (dashboard on port 3000). Hard-refresh the browser (Ctrl+Shift+R)."
    exit 0
  fi
  sleep 2
done

echo "Health check failed — see: docker logs central-dashboard --tail 30"
exit 1
