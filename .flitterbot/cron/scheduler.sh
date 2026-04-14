#!/usr/bin/env bash
# Backward-compatible wrapper for the Flitterbot cron recovery loop.
set -euo pipefail

exec "$HOME/.flitterbot/cron/flitterbot-checkin.sh" "$@"
