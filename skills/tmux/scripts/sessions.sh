#!/bin/bash
# tmux session management (separate sessions model)
#
# Each worker is its own tmux session named "a" through "z", then "aa" through "ax" (50 total).
# No driver pane — the user's current terminal is the driver.
# Each session runs in its own terminal window (tiled by the WM).
# NOTE: Callers must NEVER sleep/poll to wait for session completion — rely on user prompt or hook callback.
#
# Usage:
#   sessions.sh status              - show all sessions with free/busy state
#   sessions.sh state [N]           - detect Claude UI state (IDLE/INFERRING/NO_CLAUDE)
#   sessions.sh launch [N] [DIR] [ARGS] - launch claude in session N (or first free)
#   sessions.sh quit N              - quit Claude in session N (Ctrl+C twice)
#   sessions.sh send N ["text"]     - send text + Enter (or bare Enter if no text)
#   sessions.sh clear N             - clear Claude's conversation in session N
#   sessions.sh message N "prompt"  - send prompt + verify inference started
#   sessions.sh read N              - capture what's on screen in session N

_generate_sessions() {
  local letters=(a b c d e f g h i j k l m n o p q r s t u v w x y z)
  local result=""
  for l in "${letters[@]}"; do result+="$l "; done
  for l in "${letters[@]:0:24}"; do result+="a$l "; done
  echo "$result"
}
DEFAULT_SESSIONS="$(_generate_sessions)"
SESSIONS="${TMUX2_SESSIONS:-$DEFAULT_SESSIONS}"

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

has_claude() {
  local s="$1"
  session_exists "$s" || return 1
  local pid
  pid=$(pane_pid "$s")
  [ -z "$pid" ] && return 1
  pgrep -P "$pid" -x claude >/dev/null 2>&1
}

pane_idle_seconds() {
  tmux display-message -t "$1" -p '#{pane_idle}' 2>/dev/null
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
  for s in $SESSIONS; do
    if ! session_exists "$s"; then
      echo "$s: NOT RUNNING"
    elif has_claude "$s"; then
      echo "$s: BUSY (claude)"
    elif ! is_free "$s"; then
      local pid cmd_name
      pid=$(pane_pid "$s")
      cmd_name=$(pgrep -P "$pid" | head -1 | xargs -I{} ps -o comm= -p {} 2>/dev/null)
      echo "$s: BUSY ($cmd_name)"
    else
      echo "$s: FREE"
    fi
  done
}

cmd_launch() {
  # --- Extract identity flags from ANY position in the arg list ---
  
  local stream_id="${FLITTERBOT_STREAM_ID:-}"
  local pi_session_id="${FLITTERBOT_PI_SESSION_ID:-}"
  local remaining=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --stream-id) stream_id="$2"; shift 2 ;;
      --pi-session-id) pi_session_id="$2"; shift 2 ;;
      *) remaining+=("$1"); shift ;;
    esac
  done

  # Remaining positional args: session, dir, args (Claude CLI flags)
  local session="" dir="" args=""
  if [[ ${#remaining[@]} -gt 0 ]]; then
    if is_valid_session "${remaining[0]}"; then
      session="${remaining[0]}"
      dir="${remaining[1]:-}"
      args="${remaining[2]:-}"
    else
      # First arg is not a session letter — treat as dir
      dir="${remaining[0]}"
      args="${remaining[1]:-}"
    fi
  fi

  # --- Session selection with mkdir lock to prevent race conditions ---
  # When multiple launches happen in parallel, they must serialize the
  # find-free-session + claim-session sequence to avoid all picking the same one.
  # Uses mkdir for locking — atomic on all platforms (macOS + Linux), unlike flock.
  local LOCK_DIR="/tmp/tmux-launch.lock"

  _lock_acquire() {
    local max_wait=10 waited=0
    while ! mkdir "$LOCK_DIR" 2>/dev/null; do
      sleep 0.2
      waited=$((waited + 1))
      if [ "$waited" -ge "$((max_wait * 5))" ]; then
        # Stale lock — remove and retry
        rm -rf "$LOCK_DIR"
      fi
    done
    # Write PID for stale lock detection
    echo $$ > "$LOCK_DIR/pid"
  }

  _lock_release() {
    rm -rf "$LOCK_DIR"
  }

  if [ -z "$session" ]; then
    # Auto-select: need exclusive lock to prevent races
    _lock_acquire

    for s in $SESSIONS; do
      if ! session_exists "$s" || is_free "$s"; then session="$s"; break; fi
    done

    if [ -z "$session" ]; then
      # No free sessions — find the longest-idle Claude session to reclaim
      local best="" best_idle=0
      for s in $SESSIONS; do
        if has_claude "$s"; then
          local state
          state=$(_pane_ui_state "$s")
          if [ "$state" = "IDLE" ]; then
            local idle_secs
            idle_secs=$(pane_idle_seconds "$s")
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
        echo "ERROR: No free sessions and no idle Claude sessions to reclaim"
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

    # Claim the session: send Ctrl-C, cd, and claude command while holding the lock.
    # The lock is held until the claude command is sent and the shell has time to
    # start it — so the next concurrent launcher sees it as busy via is_free().
    tmux send-keys -t "$session" C-c
    sleep 0.2

    if [ -n "$dir" ]; then
      tmux send-keys -t "$session" "cd $(printf '%q' "$dir")" Enter
      sleep 0.3
    fi

    local cmd="env -u CLAUDECODE FLITTERBOT_AGENT_MANAGED=1 FLITTERBOT_TMUX_SESSION=$session FLITTERBOT_STREAM_ID=${stream_id} FLITTERBOT_PI_SESSION_ID=${pi_session_id} claude --dangerously-skip-permissions"
    if [ -n "$args" ]; then
      cmd="$cmd $args"
    fi
    tmux send-keys -t "$session" "$cmd" Enter
    sleep 0.5  # give shell time to fork claude process before releasing lock

    _lock_release  # claude process is now starting, session no longer free
  else
    # Explicit session specified — no lock needed
    if ! session_exists "$session"; then
      tmux new-session -d -s "$session"
      echo "Created session $session"
    fi

    if ! is_free "$session"; then
      echo "ERROR: Session $session is busy"
      return 1
    fi

    # Clear any garbage on the prompt
    tmux send-keys -t "$session" C-c
    sleep 0.2

    if [ -n "$dir" ]; then
      tmux send-keys -t "$session" "cd $(printf '%q' "$dir")" Enter
      sleep 0.3
    fi

    local cmd="env -u CLAUDECODE FLITTERBOT_AGENT_MANAGED=1 FLITTERBOT_TMUX_SESSION=$session FLITTERBOT_STREAM_ID=${stream_id} FLITTERBOT_PI_SESSION_ID=${pi_session_id} claude --dangerously-skip-permissions"
    if [ -n "$args" ]; then
      cmd="$cmd $args"
    fi
    tmux send-keys -t "$session" "$cmd" Enter
  fi

  # Wait for Claude to actually start (poll up to ~15s)
  local launch_attempt
  for launch_attempt in $(seq 1 15); do
    sleep 1
    if has_claude "$session"; then
      # Claude process exists — now wait for it to become IDLE (ready for input)
      local ready_attempt
      for ready_attempt in $(seq 1 16); do
        local ui_state
        ui_state=$(_pane_ui_state "$session")
        if [ "$ui_state" = "IDLE" ]; then
          echo "Launched in session $session (ready)"
          return 0
        fi
        sleep 0.5
      done
      # Claude is running but didn't reach IDLE — still usable
      echo "Launched in session $session (Claude running, may still be loading)"
      return 0
    fi
  done
  echo "WARNING: Launch command sent to session $session but Claude not detected after 15s. Check manually."
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
  if has_claude "$session"; then
    tmux send-keys -t "$session" C-c
    sleep 0.5
    tmux send-keys -t "$session" C-c
    echo "Quit Claude in session $session"
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
  echo "Cleared Claude conversation in session $session"
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

  # Guard: don't send to a session that's already inferring
  local pre_state
  pre_state=$(_pane_ui_state "$session")
  if [ "$pre_state" = "INFERRING" ]; then
    echo "ERROR: Session $session is currently inferring. Wait until idle."
    return 1
  fi
  if [ "$pre_state" = "NO_CLAUDE" ]; then
    echo "ERROR: Session $session has no Claude running"
    return 1
  fi

  _prep_input "$session"
  tmux send-keys -t "$session" -l "$prompt"
  tmux send-keys -t "$session" Enter
  echo "Sent prompt to Claude in session $session"

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
  local uuid
  uuid=$(tmux capture-pane -t "$session" -p | tail -10 | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1)
  if [ -n "$uuid" ]; then
    echo "$uuid"
  else
    echo "NOT_FOUND"
    return 1
  fi
}

_pane_ui_state() {
  local session="$1"
  if ! has_claude "$session"; then
    echo "NO_CLAUDE"
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
  elif has_claude "$s"; then
    state=$(_pane_ui_state "$s")
    if [ "$state" = "IDLE" ]; then
      idle_secs=$(pane_idle_seconds "$s")
      idle_secs=${idle_secs:-0}
      idle_str=$(format_idle "$idle_secs")
      echo "$s: IDLE ($idle_str)"
    else
      echo "$s: $state"
    fi
  elif is_free "$s"; then
    idle_secs=$(pane_idle_seconds "$s")
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
