#!/usr/bin/env bash
set -euo pipefail

echo "[!] This will stop containers and REMOVE data volumes (cold reset)."
read -p "Proceed? [y/N] " ans
case "${ans:-}" in
  y|Y|yes|YES)
    ;;
  *)
    echo "Aborted."; exit 1;
    ;;
esac

docker compose down -v
echo "[+] All containers and volumes removed."

