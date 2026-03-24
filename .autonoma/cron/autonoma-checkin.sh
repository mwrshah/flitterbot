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

read_config() {
  node -e "
    const c = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
    process.stdout.write([
      c.controlSurfaceToken || '',
      c.controlSurfaceHost || '127.0.0.1',
      String(c.controlSurfacePort || 18820),
    ].join('\n'));
  " "$CONFIG_FILE"
}

config_output=$(read_config 2>/dev/null || true)
if [[ -z "$config_output" ]]; then
  exit 0
fi

TOKEN=$(sed -n '1p' <<< "$config_output")
HOST=$(sed -n '2p' <<< "$config_output")
PORT=$(sed -n '3p' <<< "$config_output")

if [[ -z "${TOKEN:-}" ]]; then
  exit 0
fi

curl -sf -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  "http://${HOST}:${PORT}/cron/tick" \
  || true
