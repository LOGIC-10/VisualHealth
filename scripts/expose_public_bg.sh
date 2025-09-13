#!/usr/bin/env bash
set -euo pipefail

# Background, non-interactive public exposure via Cloudflare Quick Tunnel.
# - Starts Docker stack (single-port mode) and then runs cloudflared in background.
# - Writes logs to cloudflared.log and PID to cloudflared.pid in repo root.
# - Prints the public URL when available.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[!] cloudflared is not installed. Install via: brew install cloudflared" >&2
  exit 1
fi

echo "[1/4] Starting stack (single-port) ..."
docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.tunnel.yml up -d --build

echo "[2/4] Waiting for frontend on http://localhost:3000 ..."
ATTEMPTS=0
until curl -sfS http://localhost:3000 >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS+1))
  if [ $ATTEMPTS -gt 90 ]; then
    echo "[!] Frontend did not become ready in time." >&2
    exit 1
  fi
  sleep 1
done

echo "[3/4] Launching cloudflared in background ..."
LOG="$ROOT_DIR/cloudflared.log"
PID="$ROOT_DIR/cloudflared.pid"
if [ -f "$PID" ] && ps -p "$(cat "$PID" 2>/dev/null)" >/dev/null 2>&1; then
  echo "[i] Existing cloudflared process detected (PID $(cat "$PID")). Reusing."
else
  nohup cloudflared tunnel --no-autoupdate --url http://localhost:3000 > "$LOG" 2>&1 &
  echo $! > "$PID"
  disown || true
fi

echo "[4/4] Waiting for public URL ..."
PUBLIC_URL=""
for i in $(seq 1 60); do
  if [ -f "$LOG" ]; then
    # Parse the first trycloudflare URL printed by cloudflared
    PUBLIC_URL=$(awk '/https:\/\/.*\.trycloudflare\.com/ {print $NF; exit}' "$LOG" | head -n1)
    if [ -n "$PUBLIC_URL" ]; then break; fi
  fi
  sleep 1
done

if [ -z "$PUBLIC_URL" ]; then
  echo "[!] Could not detect public URL yet. Check $LOG for details."
  exit 1
fi

echo "Public URL: $PUBLIC_URL"
echo "Logs: $LOG | PID: $(cat "$PID")"
exit 0

