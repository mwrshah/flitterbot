#!/bin/bash
# tmux session management (separate sessions model)
#
# Each worker is its own tmux session named "a" through "z", then "aa" through "ax" (50 total).
# No driver pane — the user's current terminal is the driver.
# Each session runs in its own terminal window (tiled by the WM).
# NOTE: Callers must NEVER sleep/poll to wait for session completion — rely on user prompt or hook callback.
# Subcommands and their arguments are documented in ../SKILL.md.
# Harness (claude/codex) is chosen via --harness or config.json "harness" (default claude). Codex launches
# with --yolo --dangerously-bypass-hook-trust; its "working" state is the "esc to interrupt" status line;
# its session id is read from the newest ~/.codex rollout matching the pane cwd (not shown on screen).
# ponytail: this duplicates TypeScript tmux UI detection; keep one implementation or generate one from the other.

_generate_sessions() {
  local letters=(a b c d e f g h i j k l m n o p q r s t u v w x y z)
  local result=""
  for l in "${letters[@]}"; do result+="$l "; done
  for l in "${letters[@]:0:24}"; do result+="a$l "; done
  echo "$result"
}
DEFAULT_SESSIONS="$(_generate_sessions)"
SESSIONS="${TMUX2_SESSIONS:-$DEFAULT_SESSIONS}"

CONFIG_PATH="${FLITTERBOT_CONFIG:-$HOME/.flitterbot/config.json}"

_resolve_launch_harness() {
  local explicit="$1"
  if [ -n "$explicit" ]; then echo "$explicit"; return; fi
  local h=""
  if [ -f "$CONFIG_PATH" ]; then
    h=$(sed -n 's/.*"harness"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG_PATH" | head -1)
  fi
  echo "${h:-claude}"
}

_validate_harness() {
  case "$1" in
    claude|codex) return 0 ;;
    *) echo "ERROR: --harness must be claude or codex"; return 1 ;;
  esac
}

is_valid_session() {
  local name="$1"
  for s in $SESSIONS; do
    [ "$s" = "$name" ] && return 0
  done
  return 1
}

session_exists() {
  tmux has-session -t "$1" 2>/dev/null
}

pane_pid() {
  tmux display-message -t "$1" -p '#{pane_pid}' 2>/dev/null
}

is_free() {
  local s="$1"
  session_exists "$s" || return 1
  local pid
  pid=$(pane_pid "$s")
  [ -z "$pid" ] && return 1
  ! pgrep -P "$pid" >/dev/null 2>&1
}

session_harness() {
  local s="$1"
  session_exists "$s" || return 1
  local pid
  pid=$(pane_pid "$s")
  [ -z "$pid" ] && return 1
  if pgrep -P "$pid" -x claude >/dev/null 2>&1; then echo "claude"; return 0; fi
  if pgrep -P "$pid" -x codex  >/dev/null 2>&1; then echo "codex";  return 0; fi
  return 1
}

has_agent() {
  session_harness "$1" >/dev/null 2>&1
}

session_idle_seconds() {
  local activity now
  activity=$(tmux display-message -t "$1" -p '#{session_activity}' 2>/dev/null)
  if ! [[ "$activity" =~ ^[0-9]+$ ]]; then
    echo 0
    return
  fi
  now=$(date +%s)
  if [ "$activity" -ge "$now" ]; then
    echo 0
  else
    echo "$((now - activity))"
  fi
}

format_idle() {
  local secs="${1:-0}"
  if [ "$secs" -ge 3600 ]; then
    echo "$((secs / 3600))h$((secs % 3600 / 60))m"
  elif [ "$secs" -ge 60 ]; then
    echo "$((secs / 60))m"
  else
    echo "${secs}s"
  fi
}

cmd_status() {
  cmd_state
}

_agent_launch_cmd() {
  local harness="$1" session="$2" stream_id="$3" pi_session_id="$4" args="$5"
  local envp="env -u CLAUDECODE FLITTERBOT_AGENT_MANAGED=1 FLITTERBOT_HARNESS=$harness FLITTERBOT_TMUX_SESSION=$session FLITTERBOT_STREAM_ID=${stream_id} FLITTERBOT_PI_SESSION_ID=${pi_session_id}"
  local cmd
  if [ "$harness" = "codex" ]; then
    cmd="$envp codex --yolo --dangerously-bypass-hook-trust"
  else
    cmd="$envp claude --dangerously-skip-permissions"
  fi
  if [ -n "$args" ]; then
    cmd="$cmd $args"
  fi
  echo "$cmd"
}

cmd_launch() {
  local stream_id="${FLITTERBOT_STREAM_ID:-}"
  local pi_session_id="${FLITTERBOT_PI_SESSION_ID:-}"
  local harness_arg=""
  local remaining=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --stream-id) stream_id="$2"; shift 2 ;;
      --pi-session-id) pi_session_id="$2"; shift 2 ;;
      --harness) harness_arg="$2"; shift 2 ;;
      *) remaining+=("$1"); shift ;;
    esac
  done
  local harness
  harness=$(_resolve_launch_harness "$harness_arg")
  _validate_harness "$harness" || return 1

  local session="" dir="${remaining[0]:-}" args="${remaining[1]:-}"
  if [ -n "$dir" ] && is_valid_session "$dir"; then
    echo "ERROR: launch allocates a tmux session automatically; use message $dir \"prompt\" to reprompt its agent"
    return 1
  fi

  local LOCK_DIR="/tmp/tmux-launch.lock"
  local SHELL_FORK_GRACE_SECONDS=0.5

  _lock_break_stale() {
    rm -rf "$LOCK_DIR"
  }

  _lock_acquire() {
    local max_wait=10 waited=0
    while ! mkdir "$LOCK_DIR" 2>/dev/null; do
      sleep 0.2
      waited=$((waited + 1))
      if [ "$waited" -ge "$((max_wait * 5))" ]; then
        _lock_break_stale
      fi
    done
    echo $$ > "$LOCK_DIR/pid"
  }

  _lock_release() {
    rm -rf "$LOCK_DIR"
  }

  _lock_acquire

  for s in $SESSIONS; do
    if ! session_exists "$s" || is_free "$s"; then session="$s"; break; fi
  done

  if [ -z "$session" ]; then
    local best="" best_idle=0
    for s in $SESSIONS; do
      if has_agent "$s"; then
        local state
        state=$(_pane_ui_state "$s")
        if [ "$state" = "IDLE" ]; then
          local idle_secs
          idle_secs=$(session_idle_seconds "$s")
          idle_secs=${idle_secs:-0}
          if [ "$idle_secs" -gt "$best_idle" ]; then
            best="$s"
            best_idle="$idle_secs"
          fi
        fi
      fi
    done
    if [ -z "$best" ]; then
      _lock_release
      echo "ERROR: No free tmux sessions and no idle agents to reclaim"
      return 1
    fi
    echo "Reclaiming session $best (idle $(format_idle "$best_idle"))"
    cmd_quit "$best"
    sleep 2
    session="$best"
  fi

  if ! session_exists "$session"; then
    tmux new-session -d -s "$session"
    echo "Created session $session"
  fi

  if ! is_free "$session"; then
    _lock_release
    echo "ERROR: Session $session is busy"
    return 1
  fi

  tmux send-keys -t "$session" C-c
  sleep 0.2

  if [ -n "$dir" ]; then
    tmux send-keys -t "$session" "cd $(printf '%q' "$dir")" Enter
    sleep 0.3
  fi

  local cmd
  cmd=$(_agent_launch_cmd "$harness" "$session" "$stream_id" "$pi_session_id" "$args")
  tmux send-keys -t "$session" "$cmd" Enter
  sleep "$SHELL_FORK_GRACE_SECONDS"

  _lock_release

  local launch_attempt
  for launch_attempt in $(seq 1 15); do
    sleep 1
    if has_agent "$session"; then
      local ready_attempt
      for ready_attempt in $(seq 1 16); do
        local ui_state
        ui_state=$(_pane_ui_state "$session")
        if [ "$ui_state" = "TRUST_PROMPT" ]; then
          tmux send-keys -t "$session" Enter
        elif [ "$ui_state" = "IDLE" ]; then
          echo "Launched in session $session (ready)"
          return 0
        fi
        sleep 0.5
      done
      echo "Launched in session $session ($harness running, may still be loading)"
      return 0
    fi
  done
  echo "WARNING: Launch command sent to session $session but $harness not detected after 15s. Check manually."
  return 1
}

cmd_quit() {
  local session="$1"
  if [ -z "$session" ]; then
    echo "ERROR: Specify session number"
    return 1
  fi
  if ! session_exists "$session"; then
    echo "Session $session does not exist"
    return 1
  fi
  if is_free "$session"; then
    echo "Session $session is already free"
    return 0
  fi
  if has_agent "$session"; then
    tmux send-keys -t "$session" C-c
    sleep 0.5
    tmux send-keys -t "$session" C-c
    echo "Quit agent in session $session"
  else
    tmux send-keys -t "$session" C-c
    echo "Quit process in session $session"
  fi
}


cmd_send() {
  local session="$1"
  local text="$2"
  if [ -z "$session" ]; then
    echo "ERROR: Usage: sessions.sh send N [\"text\"]"
    return 1
  fi
  if ! session_exists "$session"; then
    echo "ERROR: Session $session does not exist"
    return 1
  fi
  if [ -z "$text" ]; then
    tmux send-keys -t "$session" Enter
    echo "Sent Enter to session $session"
  else
    tmux send-keys -t "$session" "$text" Enter
    echo "Sent to session $session"
  fi
}

_prep_input() {
  if [ "$(session_harness "$1")" = "codex" ]; then
    tmux send-keys -t "$1" C-u
    sleep 0.1
    return
  fi
  tmux send-keys -t "$1" Escape
  sleep 0.1
  tmux send-keys -t "$1" C-l
  sleep 0.1
  tmux send-keys -t "$1" i
  sleep 0.1
}

cmd_clear() {
  local session="$1"
  if [ -z "$session" ]; then
    echo "ERROR: Specify session number"
    return 1
  fi
  if ! session_exists "$session"; then
    echo "ERROR: Session $session does not exist"
    return 1
  fi
  _prep_input "$session"
  tmux send-keys -t "$session" -l '/clear'
  tmux send-keys -t "$session" Enter
  echo "Cleared agent conversation in session $session"
}

cmd_message() {
  local session="$1"
  local prompt="$2"
  if [ -z "$session" ] || [ -z "$prompt" ]; then
    echo "ERROR: Usage: sessions.sh message N \"prompt\""
    return 1
  fi
  if ! session_exists "$session"; then
    echo "ERROR: Session $session does not exist"
    return 1
  fi

  local pre_state
  pre_state=$(_pane_ui_state "$session")
  if [ "$pre_state" = "INFERRING" ]; then
    echo "ERROR: Session $session is currently inferring. Wait until idle."
    return 1
  fi
  if [ "$pre_state" = "NO_AGENT" ]; then
    echo "ERROR: Session $session has no agent running"
    return 1
  fi

  _prep_input "$session"
  tmux send-keys -t "$session" -l "$prompt"
  tmux send-keys -t "$session" Enter
  echo "Sent prompt to session $session"

  _qc_message_sent "$session"
}

cmd_read() {
  local session="$1"
  if [ -z "$session" ]; then
    echo "ERROR: Specify session number"
    return 1
  fi
  if ! session_exists "$session"; then
    echo "ERROR: Session $session does not exist"
    return 1
  fi
  tmux capture-pane -t "$session" -p
}

_codex_session_id() {
  local session="$1" cwd base f
  cwd=$(tmux display-message -t "$session" -p '#{pane_current_path}' 2>/dev/null)
  base="$HOME/.codex/sessions"
  f=$(ls -t "$base"/*/*/*/rollout-*.jsonl 2>/dev/null | while read -r file; do
        if head -1 "$file" | grep -q "\"cwd\"[[:space:]]*:[[:space:]]*\"$cwd\""; then
          echo "$file"; break
        fi
      done)
  [ -z "$f" ] && f=$(ls -t "$base"/*/*/*/rollout-*.jsonl 2>/dev/null | head -1)
  if [ -z "$f" ]; then echo "NOT_FOUND"; return 1; fi
  echo "$f" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1
}

cmd_session_id() {
  local session="$1"
  if [ -z "$session" ]; then
    echo "ERROR: Specify session number"
    return 1
  fi
  if ! session_exists "$session"; then
    echo "ERROR: Session $session does not exist"
    return 1
  fi
  if [ "$(session_harness "$session")" = "codex" ]; then
    _codex_session_id "$session"
    return
  fi
  local uuid
  uuid=$(tmux capture-pane -t "$session" -p | tail -10 | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1)
  if [ -n "$uuid" ]; then
    echo "$uuid"
  else
    echo "NOT_FOUND"
    return 1
  fi
}

_codex_ui_state() {
  local session="$1" attempt pane
  for attempt in 1 2 3; do
    pane=$(tmux capture-pane -t "$session" -p)
    if grep -q 'Do you trust the contents of this directory?' <<< "$pane"; then
      echo "TRUST_PROMPT"
      return
    fi
    if grep -qi 'esc to interrupt' <<< "$pane"; then
      echo "INFERRING"
      return
    fi
    [ "$attempt" -lt 3 ] && sleep 0.15
  done
  echo "IDLE"
}

_pane_ui_state() {
  local session="$1"
  local harness
  harness=$(session_harness "$session") || { echo "NO_AGENT"; return; }

  if [ "$harness" = "codex" ]; then
    _codex_ui_state "$session"
    return
  fi

  local attempt
  for attempt in 1 2 3; do
    if tmux capture-pane -t "$session" -e -p | perl -e \
      'use utf8; binmode(STDIN, ":utf8");
      my %gray256 = map {$_ => 1} (7, 8, 145, 146, 148, 150, 153, 188, 231,
                                    232..255, 240..250);
      while(<>){
        next unless /[\x{2722}\x{2733}\x{2736}\x{273B}\x{273D}]/;
        my @rgb = /38;2;(\d+;\d+;\d+)/g;
        for my $c (@rgb){
          exit 0 unless $c eq "153;153;153";
        }
        my @c256 = /38;5;(\d+)/g;
        for my $n (@c256){
          exit 0 unless $gray256{$n};
        }
      } exit 1'; then
      echo "INFERRING"
      return
    fi
    [ "$attempt" -lt 3 ] && sleep 0.15
  done

  echo "IDLE"
}

_state_line() {
  local s="$1"
  local state idle_secs idle_str
  if ! session_exists "$s"; then
    echo "$s: NOT RUNNING"
  elif has_agent "$s"; then
    state=$(_pane_ui_state "$s")
    if [ "$state" = "IDLE" ]; then
      idle_secs=$(session_idle_seconds "$s")
      idle_secs=${idle_secs:-0}
      idle_str=$(format_idle "$idle_secs")
      echo "$s: IDLE ($idle_str)"
    else
      echo "$s: $state"
    fi
  elif is_free "$s"; then
    idle_secs=$(session_idle_seconds "$s")
    idle_secs=${idle_secs:-0}
    idle_str=$(format_idle "$idle_secs")
    echo "$s: FREE ($idle_str)"
  else
    echo "$s: BUSY (other)"
  fi
}

cmd_state() {
  local session="$1"
  if [ -z "$session" ]; then
    local tmpdir
    tmpdir=$(mktemp -d)
    for s in $SESSIONS; do
      ( _state_line "$s" ) > "$tmpdir/$s" &
    done
    wait
    for s in $SESSIONS; do
      cat "$tmpdir/$s"
    done
    rm -rf "$tmpdir"
  else
    if ! session_exists "$session"; then
      echo "NOT RUNNING"
    else
      _state_line "$session"
    fi
  fi
}

_qc_message_sent() {
  local session="$1"
  local max_attempts=8
  local poll_interval=0.5
  local attempt=0
  local state

  while [ $attempt -lt $max_attempts ]; do
    sleep "$poll_interval"
    state=$(_pane_ui_state "$session")

    if [ "$state" = "INFERRING" ]; then
      echo "$state"
      return 0
    fi

    attempt=$((attempt + 1))

    if [ $attempt -lt $max_attempts ]; then
      tmux send-keys -t "$session" Enter
      echo "QC: Sent extra Enter to session $session (attempt $attempt, state=$state)"
    fi
  done

  echo "$state"
  if [ "$state" != "INFERRING" ]; then
    echo "QC WARNING: Session $session did not start inferring after $max_attempts checks"
    return 1
  fi
}

case "${1:-status}" in
  status)      cmd_status ;;
  state)       cmd_state "$2" ;;
  launch)      shift; cmd_launch "$@" ;;
  quit)        cmd_quit "$2" ;;
  send)        cmd_send "$2" "$3" ;;
  clear)       cmd_clear "$2" ;;
  message)     cmd_message "$2" "$3" ;;
  read)        cmd_read "$2" ;;
  session-id)  cmd_session_id "$2" ;;
  *)           echo "Unknown command: $1"; exit 1 ;;
esac
