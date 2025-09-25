#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_node_suite() {
  local name="$1"
  local dir="$2"
  echo "==> ${name}"
  ( cd "${dir}" && npm test -- --runInBand )
}

run_python_suite() {
  local name="$1"
  local dir="$2"
  echo "==> ${name}"
  ( cd "${dir}" && pytest -q )
}

run_node_suite "web" "${ROOT_DIR}/apps/web"
run_node_suite "auth" "${ROOT_DIR}/services/auth"
run_node_suite "media" "${ROOT_DIR}/services/media"
run_node_suite "analysis" "${ROOT_DIR}/services/analysis"
run_node_suite "feed" "${ROOT_DIR}/services/feed"

run_python_suite "viz" "${ROOT_DIR}/services/viz"
run_python_suite "llm" "${ROOT_DIR}/services/llm"
