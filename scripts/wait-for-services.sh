#!/usr/bin/env bash
set -euo pipefail

TIMEOUT="${1:-180}"
DELAY=5

end_time=$((SECONDS + TIMEOUT))

check() {
  local url="$1"
  if curl -fsS "$url" >/dev/null; then
    echo "[ok] $url"
    return 0
  fi
  return 1
}

SERVICES=(
  "http://localhost:3000"
  "http://localhost:4001/health"
  "http://localhost:4003/health"
  "http://localhost:4004/health"
  "http://localhost:4005/health"
  "http://localhost:4006/docs"
  "http://localhost:4007/docs"
)

while (( SECONDS < end_time )); do
  all_up=1
  for url in "${SERVICES[@]}"; do
    if ! check "$url"; then
      all_up=0
    fi
  done

  if (( all_up == 1 )); then
    echo "All services are healthy."
    exit 0
  fi

  echo "Waiting for services..."
  sleep "$DELAY"
end

echo "Timed out after ${TIMEOUT}s waiting for services" >&2
exit 1
