#!/usr/bin/env bash

AUTONOMA_HOME="${AUTONOMA_HOME:-$HOME/.autonoma}"
AUTONOMA_CONFIG="${AUTONOMA_CONFIG:-$AUTONOMA_HOME/config.json}"
AUTONOMA_LOG_DIR="${AUTONOMA_LOG_DIR:-$AUTONOMA_HOME/logs}"
AUTONOMA_ROTATE_BYTES=$((10 * 1024 * 1024))

ensure_runtime_dirs() {
  mkdir -p "$AUTONOMA_HOME" "$AUTONOMA_LOG_DIR"
}

_file_size_bytes() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo 0
    return 0
  fi

  if stat -f%z "$path" >/dev/null 2>&1; then
    stat -f%z "$path"
  else
    stat -c%s "$path"
  fi
}

rotate_log_file() {
  local path="$1"
  ensure_runtime_dirs
  local size
  size=$(_file_size_bytes "$path")
  if (( size < AUTONOMA_ROTATE_BYTES )); then
    return 0
  fi

  rm -f "${path}.1"
  mv "$path" "${path}.1"
}

append_log() {
  local path="$1"
  local level="$2"
  local message="$3"
  rotate_log_file "$path"
  printf '[%s] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$message" >> "$path"
}

config_value() {
  local jq_expr="$1"
  local fallback="$2"
  if command -v jq >/dev/null 2>&1 && [[ -f "$AUTONOMA_CONFIG" ]]; then
    local value
    value=$(jq -r --arg fallback "$fallback" "$jq_expr // \$fallback" "$AUTONOMA_CONFIG" 2>/dev/null || true)
    if [[ -n "$value" && "$value" != "null" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  fi

  printf '%s\n' "$fallback"
}

config_int() {
  config_value "$1" "$2"
}

config_string() {
  config_value "$1" "$2"
}

expand_home_path() {
  local value="$1"
  if [[ "$value" == "~" ]]; then
    printf '%s\n' "$HOME"
  elif [[ "$value" == ~/* ]]; then
    printf '%s/%s\n' "$HOME" "${value#~/}"
  else
    printf '%s\n' "$value"
  fi
}

control_surface_host() {
  config_string '.controlSurfaceHost' '127.0.0.1'
}

control_surface_port() {
  config_int '.controlSurfacePort' '18820'
}

control_surface_base_url() {
  printf 'http://%s:%s\n' "$(control_surface_host)" "$(control_surface_port)"
}

blackboard_path() {
  local configured
  configured=$(config_string '.blackboardPath' "$AUTONOMA_HOME/blackboard.db")
  expand_home_path "$configured"
}

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

curl_status_json() {
  local host="$1"
  local port="$2"
  curl --silent --show-error --max-time 2 --connect-timeout 1 "http://${host}:${port}/status"
}

status_is_ok() {
  local body="$1"
  if [[ -z "$body" ]] || ! command -v jq >/dev/null 2>&1; then
    return 1
  fi

  printf '%s' "$body" | jq -e '.ok == true' >/dev/null 2>&1
}

status_has_active_pi() {
  local body="$1"
  if ! status_is_ok "$body"; then
    return 1
  fi

  printf '%s' "$body" | jq -e '
    .pi.default != null and
    (.pi.default.sessionId? != null and .pi.default.sessionId != "")
  ' >/dev/null 2>&1
}

wait_for_active_pi() {
  local host="$1"
  local port="$2"
  local timeout_seconds="$3"
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    local body=""
    body=$(curl_status_json "$host" "$port" 2>/dev/null || true)
    if status_has_active_pi "$body"; then
      return 0
    fi
    sleep 1
  done

  return 1
}

post_json_with_auth() {
  local method="$1"
  local url="$2"
  local token="$3"
  local json_payload="$4"

  local -a curl_args=(
    --silent
    --show-error
    --output /dev/null
    --write-out '%{http_code}'
    --connect-timeout 1
    --max-time 5
    -X "$method"
    -H 'Content-Type: application/json'
  )

  if [[ -n "$token" ]]; then
    curl_args+=(-H "Authorization: Bearer ${token}")
  fi

  curl_args+=(--data "$json_payload" "$url")
  curl "${curl_args[@]}"
}
