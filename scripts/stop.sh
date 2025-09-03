#!/usr/bin/env bash
set -euo pipefail

echo "[+] Stopping and removing all services..."
docker compose down -v
echo "[+] All services stopped."

