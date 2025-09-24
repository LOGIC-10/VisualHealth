#!/usr/bin/env bash
set -euo pipefail

compose_files=("docker-compose.yml")
if [[ "${VISUALHEALTH_INCLUDE_DEV_OVERRIDE:-0}" == "1" ]]; then
  compose_files+=("docker-compose.override.yml")
fi

log_dir="${VISUALHEALTH_LOG_DIR:-logs}"
mkdir -p "$log_dir"
log_pid_file="$log_dir/compose_logs.pid"

if [[ -f "$log_pid_file" ]]; then
  old_pid=$(cat "$log_pid_file" 2>/dev/null || true)
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "[+] Stopping previous log tail (pid $old_pid)"
    kill "$old_pid" 2>/dev/null || true
  fi
  rm -f "$log_pid_file"
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

log_file="$log_dir/compose_$(date +%Y%m%d_%H%M%S).log"
echo "[+] Streaming docker compose logs → $log_file"
nohup "${docker_cmd[@]}" logs --no-color --timestamps --follow >> "$log_file" 2>&1 &
echo $! > "$log_pid_file"
