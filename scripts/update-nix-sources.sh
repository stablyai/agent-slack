#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required" >&2
  exit 1
fi

exec bun scripts/update-nix-sources.ts "$@"
