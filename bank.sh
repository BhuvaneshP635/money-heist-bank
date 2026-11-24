#!/usr/bin/env bash
set -euo pipefail
base="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  prepare|portal) exec node "$base/bin/onboard.mjs" "$@" ;;
  -h|--help|"")
    cat <<'HELP'
Bank owner
  bash bank.sh prepare bank-Pxxx.json [--create-project]
  bash bank.sh portal bank-Pxxx.json [--workspace DIRECTORY] [--publish [--wait]]
HELP
    ;;
  *) printf 'Unknown bank owner stage: %s\n' "$1" >&2; exit 2 ;;
esac
