#!/bin/bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/skills/localhost/scripts/worktree-up.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/localhost-tests.XXXXXX")"
STATE_TMP="$ROOT/state"; FAKE_BIN="$ROOT/bin"; PIDS_FILE="$ROOT/pids"; SLOTS_FILE="$ROOT/slots"
LOCK_ROOT="${TMPDIR:-/tmp}/flitterbot-localhost-test-slots-$(id -u)"
mkdir -p "$STATE_TMP" "$FAKE_BIN" "$LOCK_ROOT"; chmod 700 "$LOCK_ROOT"; : > "$PIDS_FILE"; : > "$SLOTS_FILE"
LEGACY_FILE=""

cleanup() {
    local pid cwd
    while IFS= read -r pid; do [[ "$pid" =~ ^[0-9]+$ ]] && kill -KILL "$pid" 2>/dev/null || true; done < "$PIDS_FILE"
    while IFS= read -r pid; do
        cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
        [[ "$cwd" == "$ROOT" || "$cwd" == "$ROOT/"* ]] && kill -KILL "$pid" 2>/dev/null || true
    done < <(lsof -t +D "$ROOT" 2>/dev/null | sort -u || true)
    [[ -z "$LEGACY_FILE" ]] || rm -f "$LEGACY_FILE"
    while IFS= read -r slot; do rmdir "$LOCK_ROOT/$slot" 2>/dev/null || true; done < "$SLOTS_FILE"
    rmdir "$LOCK_ROOT" 2>/dev/null || true
    rm -rf "$ROOT"
}
trap cleanup EXIT INT TERM

cat > "$FAKE_BIN/op" <<'SH'
#!/bin/bash
while [[ $# -gt 0 && "$1" != -- ]]; do shift; done
[[ "${1:-}" == -- ]] && shift
export PORT=9999 TEST_API_URL=wrong
exec "$@"
SH
chmod +x "$FAKE_BIN/op"

fail() { echo "not ok - $1" >&2; exit 1; }
pass() { echo "ok - $1"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "expected output to contain: $2"; }
assert_dead() { ! kill -0 "$1" 2>/dev/null || fail "PID $1 is still alive"; }
assert_alive() { kill -0 "$1" 2>/dev/null || fail "PID $1 is not alive"; }

next_slot=620
free_slot() {
    while [[ $next_slot -lt 900 ]]; do
        if mkdir "$LOCK_ROOT/$next_slot" 2>/dev/null; then
            if ! lsof -nP -iTCP:"$((3000 + next_slot))" -sTCP:LISTEN >/dev/null 2>&1 && ! lsof -nP -iTCP:"$((8000 + next_slot))" -sTCP:LISTEN >/dev/null 2>&1; then
                SLOT=$next_slot; echo "$SLOT" >> "$SLOTS_FILE"; next_slot=$((next_slot + 1)); return
            fi
            rmdir "$LOCK_ROOT/$next_slot"
        fi
        next_slot=$((next_slot + 1))
    done
    fail "no isolated localhost test slot available"
}

make_repo() {
    free_slot
    CASE_NAME="${2:-$SLOT-$1}"; REPO="$ROOT/repo-$SLOT"; WT="$ROOT/$CASE_NAME"
    mkdir -p "$REPO/backend" "$REPO/frontend"; touch "$REPO/backend/.keep" "$REPO/frontend/.keep"
    cat > "$REPO/listener.py" <<'PY'
import os, socket, sys, time
if os.environ.get("EXPECT_PORT") is not None:
    if os.environ["EXPECT_PORT"] != sys.argv[1] or os.environ.get("PORT") != sys.argv[1]: raise SystemExit("wrong own-port environment")
    if not os.environ.get("TEST_API_URL", "").startswith("http://localhost:") or "{" in os.environ["TEST_API_URL"]: raise SystemExit("wrong service URL environment")
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen()
while True: time.sleep(1)
PY
    cat > "$REPO/tree.py" <<'PY'
import subprocess, sys, time
listener = subprocess.Popen([sys.executable, "../listener.py", sys.argv[1]])
sleeper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(3600)"])
with open("../tree-pids", "w") as f: f.write(f"{listener.pid} {sleeper.pid}\n")
while True: time.sleep(1)
PY
    git -C "$REPO" init -q
    git -C "$REPO" config user.email localhost-tests@example.com; git -C "$REPO" config user.name localhost-tests
    git -C "$REPO" add .; git -C "$REPO" commit -qm init
    git -C "$REPO" worktree add -q -b "$CASE_NAME" "$WT"
    git -C "$REPO" config --local --add flitterbot.localhost.service backend
    git -C "$REPO" config --local flitterbot.localhost.backend.dir backend
    git -C "$REPO" config --local flitterbot.localhost.backend.command 'python3 ../listener.py {port}'
    git -C "$REPO" config --local flitterbot.localhost.backend.port 8000
    git -C "$REPO" config --local flitterbot.localhost.backend.op-env test
    git -C "$REPO" config --local --add flitterbot.localhost.service frontend
    git -C "$REPO" config --local flitterbot.localhost.frontend.dir frontend
    git -C "$REPO" config --local flitterbot.localhost.frontend.command 'python3 ../listener.py {port}'
    git -C "$REPO" config --local flitterbot.localhost.frontend.port 3000
    git -C "$REPO" config --local flitterbot.localhost.frontend.op-env test
    git -C "$REPO" config --local --add flitterbot.localhost.frontend.env 'TEST_API_URL={service.backend.url}'
    git -C "$REPO" config --local --add flitterbot.localhost.frontend.env 'EXPECT_PORT={port}'
}

run_localhost() { (cd "$REPO" && PATH="$FAKE_BIN:$PATH" TMPDIR="$STATE_TMP" XDG_RUNTIME_DIR="$STATE_TMP" /bin/bash "$SCRIPT" "$@"); }
repo_key() { git -C "$REPO" rev-parse --path-format=absolute --git-common-dir | shasum -a 256 | awk '{print substr($1, 1, 16)}'; }
state_file() { echo "$STATE_TMP/flitterbot-localhost-$(id -u)/$(repo_key)/$CASE_NAME.state"; }
track_state_roots() { awk -F '|' 'NR > 2 {print $2}' "$(state_file)" >> "$PIDS_FILE"; }

start_listener() {
    local cwd="$1" port="$2"
    (cd "$cwd" && exec python3 "$REPO/listener.py" "$port") &
    LISTENER_PID=$!; echo "$LISTENER_PID" >> "$PIDS_FILE"
    for _ in 1 2 3 4 5; do lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return; sleep 1; done
    fail "dummy listener failed on $port"
}

make_repo missing-state
start_listener "$WT/frontend" "$((3000 + SLOT))"
out="$(run_localhost --status "$SLOT")"; assert_contains "$out" "PID $LISTENER_PID"
run_localhost --stop "$SLOT" >/dev/null; assert_dead "$LISTENER_PID"
pass "occupied configured port with missing state is discovered and stopped"

make_repo stale-state
start_listener "$WT/frontend" "$((3000 + SLOT))"
mkdir -p "$(dirname "$(state_file)")" /tmp/worktree-up; printf '2\nwrong\n999,998\n' > "$(state_file)"
LEGACY_FILE="/tmp/worktree-up/$CASE_NAME.pids"; printf '999,998,1,2\n' > "$LEGACY_FILE"
out="$(run_localhost --stop "$SLOT" 2>&1)"; assert_contains "$out" "Ignoring malformed/stale state"
[[ ! -e "$(state_file)" && ! -e "$LEGACY_FILE" ]] || fail "stale state was not cleaned"; LEGACY_FILE=""
assert_dead "$LISTENER_PID"
pass "stale PID state falls back to configured listener ownership"

make_repo legacy-tree
LEGACY_PORT=$((18000 + SLOT))
(cd "$WT/backend" && exec /bin/bash -c 'python3 ../listener.py "$1" & wait' _ "$LEGACY_PORT") &
legacy_root=$!; echo "$legacy_root" >> "$PIDS_FILE"
for _ in 1 2 3 4 5; do lsof -nP -iTCP:"$LEGACY_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 1; done
legacy_child="$(lsof -tiTCP:"$LEGACY_PORT" -sTCP:LISTEN)"; echo "$legacy_child" >> "$PIDS_FILE"
mkdir -p /tmp/worktree-up; LEGACY_FILE="/tmp/worktree-up/$CASE_NAME.pids"; printf '%s,999999,%s,0\n' "$legacy_root" "$LEGACY_PORT" > "$LEGACY_FILE"
run_localhost --stop "$SLOT" >/dev/null; assert_dead "$legacy_root"; assert_dead "$legacy_child"; [[ ! -e "$LEGACY_FILE" ]] || fail "legacy state was not removed"; LEGACY_FILE=""
pass "legacy launcher roots are safely migrated into process-tree stop"

UNNUM_NAME="unnumbered-recovery-$$"; suffix=0
while true; do
    UNNUM_NAME="unnumbered-recovery-$$-$suffix"; HASH_SLOT=$(( $(printf '%s' "$UNNUM_NAME" | cksum | awk '{print $1}') % 900 + 1 )); NEXT_HASH_SLOT=$((HASH_SLOT % 900 + 1))
    if mkdir "$LOCK_ROOT/$HASH_SLOT" 2>/dev/null; then
        if mkdir "$LOCK_ROOT/$NEXT_HASH_SLOT" 2>/dev/null; then
            if ! lsof -nP -iTCP:"$((3000 + HASH_SLOT))" -sTCP:LISTEN >/dev/null 2>&1 && ! lsof -nP -iTCP:"$((8000 + HASH_SLOT))" -sTCP:LISTEN >/dev/null 2>&1 && ! lsof -nP -iTCP:"$((3000 + NEXT_HASH_SLOT))" -sTCP:LISTEN >/dev/null 2>&1 && ! lsof -nP -iTCP:"$((8000 + NEXT_HASH_SLOT))" -sTCP:LISTEN >/dev/null 2>&1; then
                echo "$HASH_SLOT" >> "$SLOTS_FILE"; echo "$NEXT_HASH_SLOT" >> "$SLOTS_FILE"; break
            fi
            rmdir "$LOCK_ROOT/$NEXT_HASH_SLOT" 2>/dev/null || true
        fi
        rmdir "$LOCK_ROOT/$HASH_SLOT" 2>/dev/null || true
    fi
    suffix=$((suffix + 1))
done
make_repo unnumbered "$UNNUM_NAME"
OUTSIDE="$ROOT/unnumbered-outside"; mkdir -p "$OUTSIDE"; start_listener "$OUTSIDE" "$((3000 + HASH_SLOT))"; outside_pid="$LISTENER_PID"
run_localhost "$UNNUM_NAME" >/dev/null; track_state_roots; rm -f "$(state_file)"
out="$(run_localhost --status "$UNNUM_NAME")"; assert_contains "$out" ":$((3000 + NEXT_HASH_SLOT))"
run_localhost --stop "$UNNUM_NAME" >/dev/null; assert_alive "$outside_pid"; kill "$outside_pid"; wait "$outside_pid" 2>/dev/null || true
pass "unnumbered missing-state recovery discovers an escalated deterministic slot"

make_repo unrelated-owner
OUTSIDE="$ROOT/outside-$SLOT"; mkdir -p "$OUTSIDE"; start_listener "$OUTSIDE" "$((3000 + SLOT))"
set +e; out="$(run_localhost --stop "$SLOT" 2>&1)"; rc=$?; set -e
[[ $rc -ne 0 ]] || fail "unrelated owner stop unexpectedly succeeded"
assert_contains "$out" "Refusing unrelated owner"; assert_alive "$LISTENER_PID"
kill "$LISTENER_PID"; wait "$LISTENER_PID" 2>/dev/null || true
pass "unrelated listener is identified and left running"

make_repo process-tree
git -C "$REPO" config --local flitterbot.localhost.backend.command 'python3 ../tree.py {port}'
run_localhost "$SLOT" >/dev/null; track_state_roots
for _ in 1 2 3 4 5; do [[ -f "$WT/tree-pids" ]] && break; sleep 1; done
read -r tree_listener tree_sleeper < "$WT/tree-pids"; echo "$tree_listener" >> "$PIDS_FILE"; echo "$tree_sleeper" >> "$PIDS_FILE"
run_localhost --stop "$SLOT" >/dev/null; assert_dead "$tree_listener"; assert_dead "$tree_sleeper"
pass "tracked service roots terminate their complete process trees"

make_repo failed-launch
git -C "$REPO" config --local flitterbot.localhost.frontend.command 'exit 23'
set +e; out="$(run_localhost "$SLOT" 2>&1)"; rc=$?; set -e
[[ $rc -ne 0 ]] || fail "failed service launch unexpectedly succeeded"; assert_contains "$out" "frontend failed to become ready"
[[ ! -e "$(state_file)" ]] || fail "failed launch left state behind"
[[ -z "$(lsof -tiTCP:$((8000 + SLOT)) -sTCP:LISTEN 2>/dev/null)" ]] || fail "failed launch left backend listening"
pass "failed launch rolls back started services and state"

make_repo portless
mkdir -p "$WT/worker"
git -C "$REPO" config --local --add flitterbot.localhost.service worker
git -C "$REPO" config --local flitterbot.localhost.worker.dir worker
git -C "$REPO" config --local flitterbot.localhost.worker.command 'python3 -c "import time; time.sleep(3600)"'
run_localhost "$SLOT" >/dev/null; track_state_roots
worker_pid="$(awk -F '|' '$1 == "worker" {print $2}' "$(state_file)")"; echo "$worker_pid" >> "$PIDS_FILE"; assert_alive "$worker_pid"
run_localhost --stop "$SLOT" >/dev/null; assert_dead "$worker_pid"
pass "portless configured services stop through tracked process ownership"

make_repo resolution
out="$(run_localhost --status "$SLOT")"; assert_contains "$out" "$CASE_NAME"
assert_contains "$out" ":$((8000 + SLOT))"; assert_contains "$out" ":$((3000 + SLOT))"
SHARED_PORT=$((12000 + SLOT)); while lsof -nP -iTCP:"$SHARED_PORT" -sTCP:LISTEN >/dev/null 2>&1; do SHARED_PORT=$((SHARED_PORT + 1)); done
git -C "$REPO" config --local flitterbot.localhost.backend.scope shared
git -C "$REPO" config --local flitterbot.localhost.backend.port "$SHARED_PORT"
out="$(run_localhost --status "$SLOT")"; assert_contains "$out" "backend (shared) :$SHARED_PORT"
run_localhost "$SLOT" >/dev/null; track_state_roots
out="$(run_localhost --list)"; assert_contains "$out" "$CASE_NAME"; [[ "$out" != *$'\n  main'* ]] || fail "shared service was attributed to every worktree"
set +e; sibling_out="$(run_localhost --stop main 2>&1)"; sibling_rc=$?; set -e
[[ $sibling_rc -ne 0 ]] || fail "sibling worktree stopped a shared service"; assert_contains "$sibling_out" "Refusing unrelated owner"
lsof -nP -iTCP:"$SHARED_PORT" -sTCP:LISTEN >/dev/null || fail "shared service did not survive sibling stop"
run_localhost --stop "$SLOT" >/dev/null
pass "worktree resolution, deterministic ports, and shared-service scope are explicit"

make_repo override
OVERRIDE=$((46000 + SLOT)); while lsof -nP -iTCP:"$OVERRIDE" -sTCP:LISTEN >/dev/null 2>&1; do OVERRIDE=$((OVERRIDE + 1)); done
run_localhost "$SLOT" --port "frontend=$OVERRIDE" >/dev/null; track_state_roots
lsof -nP -iTCP:"$OVERRIDE" -sTCP:LISTEN >/dev/null || fail "frontend override did not bind"
out="$(run_localhost --status "$SLOT")"; assert_contains "$out" ":$OVERRIDE"
run_localhost --stop "$SLOT" >/dev/null
pass "explicit per-service port override is persisted for status and stop"

make_repo normal
out="$(run_localhost --config)"; assert_contains "$out" "flitterbot.localhost.service backend"
run_localhost "$SLOT" >/dev/null; track_state_roots
out="$(run_localhost --list)"; assert_contains "$out" "$CASE_NAME"; assert_contains "$out" "PID"
run_localhost --stop "$SLOT" >/dev/null
out="$(run_localhost --list)"; assert_contains "$out" "none"
pass "repository-local config parsing and normal start/list/stop stay coherent"
