#!/usr/bin/env bash
set -euo pipefail

echo "[+] Stopping services (preserving data volumes)..."
docker compose down
echo "[+] All services stopped."
