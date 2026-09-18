#!/usr/bin/env bash
set -euo pipefail

FLITTERBOT_HOME="${FLITTERBOT_HOME:-$HOME/.flitterbot}"
source "$FLITTERBOT_HOME/scripts/runtime-common.sh"
TOKEN=$(config_string '.controlSurfaceToken' '')
HOST=$(control_surface_host)
PORT=$(control_surface_port)

if [[ -z "$TOKEN" ]]; then
  exit 0
fi

curl -sf -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  "http://${HOST}:${PORT}/cron/tick" \
  || true
