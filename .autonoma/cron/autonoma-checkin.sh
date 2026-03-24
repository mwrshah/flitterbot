#!/usr/bin/env bash
# Autonoma cron tick — ping the control surface if it's running.
# If the surface is down, curl fails silently and we exit 0.
# All decision logic lives in the control surface's POST /cron/tick endpoint.
set -euo pipefail

AUTONOMA_HOME="${AUTONOMA_HOME:-$HOME/.autonoma}"
CONFIG_FILE="$AUTONOMA_HOME/config.json"

# Read token and connection details from config
if [[ ! -f "$CONFIG_FILE" ]]; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not installed" >&2
  exit 1
fi

TOKEN=$(jq -r '.controlSurfaceToken // empty' "$CONFIG_FILE")
HOST=$(jq -r '.controlSurfaceHost // "127.0.0.1"' "$CONFIG_FILE")
PORT=$(jq -r '.controlSurfacePort // 18820' "$CONFIG_FILE")

if [[ -z "${TOKEN:-}" ]]; then
  exit 0
fi

curl -sf -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  "http://${HOST}:${PORT}/cron/tick" \
  || true
