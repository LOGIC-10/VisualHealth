#!/usr/bin/env bash
set -euo pipefail

compose_files=("docker-compose.yml")
if [[ "${VISUALHEALTH_INCLUDE_DEV_OVERRIDE:-0}" == "1" ]]; then
  compose_files+=("docker-compose.override.yml")
fi

docker_cmd=(docker compose)
for file in "${compose_files[@]}"; do
  docker_cmd+=(-f "$file")
done

if [[ "${VISUALHEALTH_SKIP_BUILD:-0}" == "1" ]]; then
  echo "[+] Starting all services using existing images (skip build)."
  "${docker_cmd[@]}" up -d
else
  echo "[+] Building and starting all services..."
  "${docker_cmd[@]}" up --build -d
fi

echo "[+] Services are starting. Frontend: http://localhost:3000"
