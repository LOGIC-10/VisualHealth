#!/usr/bin/env bash
set -euo pipefail

compose_files=("docker-compose.yml")
if [[ "${VISUALHEALTH_INCLUDE_DEV_OVERRIDE:-0}" == "1" ]]; then
  compose_files+=("docker-compose.override.yml")
fi

log_dir="${VISUALHEALTH_LOG_DIR:-logs}"
log_pid_file="$log_dir/compose_logs.pid"

if [[ -f "$log_pid_file" ]]; then
  pid=$(cat "$log_pid_file" 2>/dev/null || true)
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "[+] Stopping log tail (pid $pid)"
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$log_pid_file"
fi

docker_cmd=(docker compose)
for file in "${compose_files[@]}"; do
  docker_cmd+=(-f "$file")
done

echo "[+] Stopping services (preserving data volumes)..."
"${docker_cmd[@]}" down
echo "[+] All services stopped."
