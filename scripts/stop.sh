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

echo "[+] Stopping services (preserving data volumes)..."
"${docker_cmd[@]}" down
echo "[+] All services stopped."
