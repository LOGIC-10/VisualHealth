#!/usr/bin/env bash
set -euo pipefail

echo "[+] Building and starting all services..."
docker compose up --build -d
echo "[+] Services are starting. Frontend: http://localhost:3000"

