#!/usr/bin/env bash
# init-db.sh — Bootstrap the Autonoma blackboard database.
# Fresh install: applies schema.sql to create all tables at the current version.
# Existing DB: reports the current schema version. Incremental migrations are
# handled by the server's TypeScript migrate.ts on startup.
set -euo pipefail

AUTONOMA_HOME="${AUTONOMA_HOME:-$HOME/.autonoma}"
AUTONOMA_CONFIG="${AUTONOMA_CONFIG:-$AUTONOMA_HOME/config.json}"
DB_PATH="${AUTONOMA_DB_PATH:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA_FILE=""
LATEST_VERSION=11

expand_home() {
  local value="$1"
  if [[ "$value" == "~" ]]; then
    printf '%s\n' "$HOME"
  elif [[ "$value" == ~/* ]]; then
    printf '%s/%s\n' "$HOME" "${value#~/}"
  else
    printf '%s\n' "$value"
  fi
}

if [[ -z "$DB_PATH" && -f "$AUTONOMA_CONFIG" ]]; then
  config_db_path="$(node -e "
    const c = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
    if (c.blackboardPath) process.stdout.write(c.blackboardPath);
  " "$AUTONOMA_CONFIG" 2>/dev/null || true)"
  if [[ -n "$config_db_path" && "$config_db_path" != "null" ]]; then
    DB_PATH="$(expand_home "$config_db_path")"
  fi
fi

if [[ -z "$DB_PATH" ]]; then
  DB_PATH="${AUTONOMA_HOME}/blackboard.db"
fi

DB_DIR="$(dirname "$DB_PATH")"

for candidate in \
  "$SCRIPT_DIR/../src/blackboard/schema.sql" \
  "$SCRIPT_DIR/../../src/blackboard/schema.sql"
do
  if [[ -f "$candidate" ]]; then
    SCHEMA_FILE="$candidate"
    break
  fi
done

if [[ -z "$SCHEMA_FILE" ]]; then
  echo "init-db.sh: could not locate src/blackboard/schema.sql" >&2
  exit 1
fi

mkdir -p "$DB_DIR"

query_scalar() {
  sqlite3 "$DB_PATH" "$1" 2>/dev/null || echo "0"
}

has_table() {
  local table_name="$1"
  [[ "$(query_scalar "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${table_name}';")" != "0" ]]
}

if [[ ! -f "$DB_PATH" ]] || ! has_table sessions; then
  # Fresh database — apply full schema and stamp at latest version
  sqlite3 "$DB_PATH" < "$SCHEMA_FILE" >/dev/null
  sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO schema_migrations(version) VALUES (${LATEST_VERSION});"
  echo "blackboard.db created at ${DB_PATH} (schema v${LATEST_VERSION})"
else
  # Existing database — report version; server handles migrations on startup
  current="$(query_scalar "SELECT COALESCE(MAX(version), 0) FROM schema_migrations;")"
  echo "blackboard.db exists at ${DB_PATH} (schema v${current})"
  if (( current < LATEST_VERSION )); then
    echo "  note: server will migrate v${current} → v${LATEST_VERSION} on next startup"
  fi
fi
