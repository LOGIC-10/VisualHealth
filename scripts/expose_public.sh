#!/usr/bin/env bash
set -euo pipefail

# Public exposure via a single port using Cloudflare Tunnel (quick tunnel) and Next.js rewrites
# Requirements:
#  - Docker + docker compose
#  - cloudflared (install: brew install cloudflared)
# Usage:
#  ./scripts/expose_public.sh
# Optional env:
#  CF_TUNNEL_TOKEN   # If you have a Cloudflare named tunnel token; otherwise quick tunnel is used

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[!] cloudflared is not installed."
  echo "    Install on macOS: brew install cloudflared"
  exit 1
fi

echo "[1/3] Starting stack with single-port proxy (Next.js rewrites) ..."
docker compose -f "$ROOT_DIR/docker-compose.yml" -f "$ROOT_DIR/docker-compose.override.yml" -f "$ROOT_DIR/docker-compose.tunnel.yml" up -d --build

echo "[2/3] Waiting for frontend on http://localhost:3000 ..."
ATTEMPTS=0
until curl -sfS http://localhost:3000 >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS+1))
  if [ $ATTEMPTS -gt 60 ]; then
    echo "[!] Frontend did not become ready in time." >&2
    exit 1
  fi
  sleep 1
done

echo "[3/3] Launching Cloudflare Tunnel for http://localhost:3000 ..."
echo "    Press Ctrl+C to stop exposure."

if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
  # Named tunnel (stable hostname configured in Cloudflare)
  cloudflared tunnel run --token "$CF_TUNNEL_TOKEN"
else
  # Quick tunnel (ephemeral *.trycloudflare.com)
  cloudflared tunnel --url http://localhost:3000
fi

