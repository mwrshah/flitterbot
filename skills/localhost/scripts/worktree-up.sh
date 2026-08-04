#!/bin/bash
# Repository-agnostic localhost launcher for registered Git worktrees.

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
log() { echo -e "${GREEN}▸${NC} $*"; }
warn() { echo -e "${YELLOW}▸${NC} $*"; }
err() { echo -e "${RED}✗${NC} $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE=launch
TARGET=""
PORT_OVERRIDES=""

usage() {
    cat <<'EOF'
Usage: worktree-up.sh [worktree-number|name|main] [--port service=port ...]
       worktree-up.sh --stop [worktree-number|name|main]
       worktree-up.sh --status [worktree-number|name|main]
       worktree-up.sh --list
       worktree-up.sh --config

Options:
  --port service=port  Override one configured service port for this launch.
  --stop, -s           Stop a worktree's verified service process trees.
  --status             Show configured ports and their exact owners.
  --list, -l           List active/stale services for this repository.
  --config             Print the repository-local localhost contract.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --stop|-s) MODE=stop ;;
        --status) MODE=status ;;
        --list|-l) MODE=list ;;
        --config) MODE=config ;;
        --port)
            shift
            [[ "${1:-}" == *=* ]] || { err "--port requires service=port"; exit 2; }
            PORT_OVERRIDES="${PORT_OVERRIDES}${1}"$'\n'
            ;;
        --help|-h) usage; exit 0 ;;
        --*) err "Unknown option: $1"; usage >&2; exit 2 ;;
        *) [[ -z "$TARGET" ]] || { err "Only one worktree may be selected."; exit 2; }; TARGET="$1" ;;
    esac
    shift
done

require_repo() {
    git rev-parse --git-dir >/dev/null 2>&1 || { err "Run from inside the target Git repository."; exit 1; }
}
require_repo

local_get() { git config --local --get "$1" 2>/dev/null || true; }
local_get_all() { git config --local --get-all "$1" 2>/dev/null || true; }

main_worktree() {
    git worktree list --porcelain | sed -n 's/^worktree //p' | head -1
}
worktree_paths() {
    git worktree list --porcelain | sed -n 's/^worktree //p'
}
common_git_dir() { git rev-parse --path-format=absolute --git-common-dir; }
repo_key() {
    local key
    if command -v shasum >/dev/null 2>&1; then key="$(common_git_dir | shasum -a 256 | awk '{print substr($1, 1, 16)}')"
    elif command -v sha256sum >/dev/null 2>&1; then key="$(common_git_dir | sha256sum | awk '{print substr($1, 1, 16)}')"
    else key="$(common_git_dir | cksum | awk '{print $1}')"
    fi
    [[ -n "$key" ]] || { err "Could not derive repository state key."; return 1; }
    echo "$key"
}
state_root() {
    local base root owner
    base="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"; root="$base/flitterbot-localhost-$(id -u)"
    [[ ! -L "$root" ]] || { err "Refusing symlinked state directory: $root"; return 1; }
    (umask 077; mkdir -p "$root")
    if stat -c '%u' "$root" >/dev/null 2>&1; then owner="$(stat -c '%u' "$root")"; else owner="$(stat -f '%u' "$root")"; fi
    [[ "$owner" == "$(id -u)" ]] || { err "State directory is owned by UID $owner, not $(id -u): $root"; return 1; }
    chmod 700 "$root"; (umask 077; mkdir -p "$root/$(repo_key)/logs")
    echo "$root/$(repo_key)"
}
state_file() { echo "$(state_root)/$1.state"; }
legacy_state_file() { echo "/tmp/worktree-up/$1.pids"; }
log_dir() { echo "$(state_root)/logs"; }

resolve_worktree() {
    local arg="${1:-}" cwd path name matches=""
    if [[ -z "$arg" ]]; then
        cwd="$(pwd -P)"
        while IFS= read -r path; do
            if [[ "$cwd" == "$path" || "$cwd" == "$path/"* ]]; then
                [[ "$path" == "$(main_worktree)" ]] && echo main || basename "$path"
                return
            fi
        done < <(worktree_paths)
        err "Current directory is not a registered worktree. Pass its number or name."
        exit 1
    fi
    arg="${arg//\//-}"
    [[ "$arg" == main ]] && { echo main; return; }
    while IFS= read -r path; do
        name="$(basename "$path")"
        [[ "$name" == "$arg" || "$name" == "$arg-"* ]] && matches="${matches}${name}"$'\n'
    done < <(worktree_paths)
    matches="$(printf '%s' "$matches" | sed '/^$/d' | sort -u)"
    [[ -n "$matches" ]] || { err "No worktree found matching '$arg'."; exit 1; }
    [[ "$(printf '%s\n' "$matches" | wc -l | tr -d ' ')" -eq 1 ]] || {
        err "Worktree '$arg' is ambiguous:"; printf '%s\n' "$matches" | sed 's/^/  /' >&2; exit 1;
    }
    echo "$matches"
}

worktree_path() {
    local name="$1" path
    [[ "$name" == main ]] && { main_worktree; return; }
    while IFS= read -r path; do
        [[ "$(basename "$path")" == "$name" ]] && { echo "$path"; return; }
    done < <(worktree_paths)
    err "Could not resolve worktree '$name'."; exit 1
}

worktree_number() {
    printf '%s' "$1" | sed -n 's/^0*\([0-9][0-9]*\).*/\1/p'
}

services() { local_get_all flitterbot.localhost.service | sed '/^$/d'; }
service_get() { local_get "flitterbot.localhost.$1.$2"; }
service_get_all() { local_get_all "flitterbot.localhost.$1.$2"; }

validate_name() { [[ "$1" =~ ^[a-z][a-z0-9-]*$ ]]; }
validate_config() {
    local seen="" service dir command port scope failed=false
    [[ -n "$(services)" ]] || { err "No localhost services configured in this repository's local .git/config."; return 1; }
    while IFS= read -r service; do
        if ! validate_name "$service"; then err "Invalid service name '$service' (use lowercase letters, numbers, and hyphens)."; failed=true; fi
        if printf '%s\n' "$seen" | grep -Fxq "$service"; then err "Duplicate flitterbot.localhost.service '$service'."; failed=true; fi
        seen="${seen}${service}"$'\n'
        dir="$(service_get "$service" dir)"; command="$(service_get "$service" command)"
        port="$(service_get "$service" port)"; scope="$(service_get "$service" scope)"; scope="${scope:-worktree}"
        [[ -n "$dir" ]] || { err "Missing flitterbot.localhost.$service.dir"; failed=true; }
        [[ -n "$command" ]] || { err "Missing flitterbot.localhost.$service.command"; failed=true; }
        [[ -z "$port" || "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || { err "Invalid flitterbot.localhost.$service.port '$port'."; failed=true; }
        [[ "$scope" == worktree || "$scope" == shared ]] || { err "Invalid flitterbot.localhost.$service.scope '$scope'."; failed=true; }
    done < <(services)
    $failed && return 1
    return 0
}

show_config() {
    validate_config
    echo -e "${BOLD}Repository-local localhost config:${NC}"
    git config --local --get-regexp '^flitterbot\.localhost\.' | sed 's/^/  /'
}

override_port() {
    local wanted="$1" entry found=""
    while IFS= read -r entry; do [[ "${entry%%=*}" == "$wanted" ]] && found="${entry#*=}"; done <<< "$PORT_OVERRIDES"
    echo "$found"
}

validate_overrides() {
    local entry service port seen=""
    while IFS= read -r entry; do
        [[ -n "$entry" ]] || continue
        service="${entry%%=*}"; port="${entry#*=}"
        [[ -n "$service" ]] || { err "--port requires a service name."; return 1; }
        printf '%s\n' "$(services)" | grep -Fxq "$service" || { err "Unknown service in --port: $service"; return 1; }
        printf '%s\n' "$seen" | grep -Fxq "$service" && { err "Duplicate --port override for '$service'."; return 1; }
        seen="${seen}${service}"$'\n'
        [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || { err "Invalid port override '$entry'."; return 1; }
    done <<< "$PORT_OVERRIDES"
}

port_pids() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true; }
pid_user() { ps -p "$1" -o user= 2>/dev/null | awk '{$1=$1; print}'; }
pid_command() { ps -p "$1" -o command= 2>/dev/null | awk '{$1=$1; print}'; }
pid_started() { ps -p "$1" -o lstart= 2>/dev/null | awk '{$1=$1; print}'; }
pid_parent() { ps -p "$1" -o ppid= 2>/dev/null | tr -d ' '; }
pid_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

pid_belongs() {
    local pid="$1" wt_path="$2" cwd parent
    [[ "$(pid_user "$pid")" == "$(id -un)" ]] || return 1
    cwd="$(pid_cwd "$pid")"; [[ -n "$cwd" ]] || return 1
    while true; do
        [[ "$cwd" -ef "$wt_path" ]] && return 0
        parent="$(dirname "$cwd")"; [[ "$parent" != "$cwd" ]] || break; cwd="$parent"
    done
    return 1
}

port_has_worktree_owner() {
    local port="$1" wt_path="$2" pid
    while IFS= read -r pid; do [[ -n "$pid" ]] && pid_belongs "$pid" "$wt_path" && return 0; done < <(port_pids "$port")
    return 1
}

discover_worktree_ports() {
    local base="$1" wt_path="$2" pid="" line port
    while IFS= read -r line; do
        case "$line" in
            p*) pid="${line#p}" ;;
            n*)
                port="$(printf '%s' "${line#n}" | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')"
                [[ -n "$pid" && -n "$port" && "$port" -gt "$base" && "$port" -le $((base + 900)) ]] || continue
                pid_belongs "$pid" "$wt_path" && echo "$port"
                ;;
        esac
    done < <(lsof -nP -a -u "$(id -un)" -iTCP -sTCP:LISTEN -Fpn 2>/dev/null || true) | sort -un
}

describe_pid() {
    local pid="$1"
    printf 'PID %s, user %s, cwd %s\n      %s\n' "$pid" "$(pid_user "$pid")" "$(pid_cwd "$pid")" "$(pid_command "$pid")"
}

describe_port() {
    local service="$1" port="$2" pid found=false
    [[ -n "$port" ]] || { printf '  %-14s no port\n' "$service"; return; }
    while IFS= read -r pid; do
        [[ -n "$pid" ]] || continue; found=true
        printf '  %-14s :%s -> ' "$service" "$port"; describe_pid "$pid"
    done < <(port_pids "$port")
    $found || printf '  %-14s :%s -> free\n' "$service" "$port"
}

state_line() {
    local file="$1" wanted="$2"
    awk -F '|' -v wanted="$wanted" 'NR > 2 && $1 == wanted { print; exit }' "$file" 2>/dev/null || true
}
state_port() { local line; line="$(state_line "$1" "$2")"; [[ -n "$line" ]] && echo "$line" | awk -F '|' '{print $4}'; return 0; }
valid_state() { [[ -f "$1" && "$(sed -n '1p' "$1")" == 3 && "$(sed -n '2p' "$1")" == "$2" ]]; }

hash_slot() {
    local name="$1" slot
    slot=$(( $(printf '%s' "$name" | cksum | awk '{print $1}') % 900 + 1 ))
    echo "$slot"
}

PLAN_SERVICES=(); PLAN_PORTS=(); PLAN_SCOPES=()
plan_index() {
    local wanted="$1" i
    for ((i=0; i<${#PLAN_SERVICES[@]}; i++)); do [[ "${PLAN_SERVICES[$i]}" == "$wanted" ]] && { echo "$i"; return; }; done
    return 1
}
plan_port() { local i; i="$(plan_index "$1")" && echo "${PLAN_PORTS[$i]}"; }

build_plan() {
    local name="$1" file="$2" for_launch="${3:-false}" service base scope override saved num slot candidate attempt conflict discovered count wt_path
    PLAN_SERVICES=(); PLAN_PORTS=(); PLAN_SCOPES=()
    num="$(worktree_number "$name")"; slot="$num"; wt_path="$(worktree_path "$name")"
    [[ -n "$slot" ]] || slot="$(hash_slot "$name")"

    if [[ -z "$num" && "$for_launch" == true ]]; then
        for ((attempt=0; attempt<900; attempt++)); do
            conflict=false
            while IFS= read -r service; do
                base="$(service_get "$service" port)"; scope="$(service_get "$service" scope)"; scope="${scope:-worktree}"
                [[ -z "$base" || "$scope" == shared || -n "$(override_port "$service")" ]] && continue
                candidate=$((base + slot))
                [[ -n "$(port_pids "$candidate")" ]] && { conflict=true; break; }
            done < <(services)
            $conflict || break
            slot=$((slot % 900 + 1))
        done
    fi

    while IFS= read -r service; do
        base="$(service_get "$service" port)"; scope="$(service_get "$service" scope)"; scope="${scope:-worktree}"
        override="$(override_port "$service")"; saved=""; discovered=""
        valid_state "$file" "$wt_path" && saved="$(state_port "$file" "$service")"
        if [[ -n "$override" ]]; then candidate="$override"
        elif [[ -n "$saved" ]]; then candidate="$saved"
        elif [[ -z "$base" ]]; then candidate=""
        elif [[ "$scope" == shared ]]; then candidate="$base"
        elif [[ "$for_launch" != true && -z "$num" ]]; then
            discovered="$(discover_worktree_ports "$base" "$wt_path/$(service_get "$service" dir)")"; count="$(printf '%s\n' "$discovered" | sed '/^$/d' | wc -l | tr -d ' ')"
            [[ "$count" -le 1 ]] || { err "Ambiguous $service listeners for '$name': $(printf '%s' "$discovered" | paste -sd, -)"; return 1; }
            candidate="${discovered:-$((base + slot))}"
        else candidate=$((base + slot))
        fi
        [[ -z "$candidate" || "$candidate" -le 65535 ]] || { err "Computed port for $service exceeds 65535."; return 1; }
        PLAN_SERVICES+=("$service"); PLAN_PORTS+=("$candidate"); PLAN_SCOPES+=("$scope")
    done < <(services)
}

expand_value() {
    local value="$1" name="$2" wt_path="$3" current_port="${4:-}" service token ref port
    value="${value//\{port\}/$current_port}"; value="${value//\{worktree\}/$name}"; value="${value//\{worktree.path\}/$wt_path}"
    while [[ "$value" =~ \{service\.([a-z][a-z0-9-]*)\.(port|url)\} ]]; do
        token="${BASH_REMATCH[0]}"; ref="${BASH_REMATCH[1]}"; port="$(plan_port "$ref" || true)"
        [[ -n "$port" ]] || { err "Environment template references portless/unknown service '$ref'."; return 1; }
        [[ "${BASH_REMATCH[2]}" == url ]] && port="http://localhost:$port"
        value="${value//$token/$port}"
    done
    echo "$value"
}

collect_tree() {
    local pid="$1" child
    echo "$pid"
    while IFS= read -r child; do [[ -n "$child" ]] && collect_tree "$child"; done < <(pgrep -P "$pid" 2>/dev/null || true)
}

is_launcher_wrapper() {
    local command="$1"
    [[ "$command" =~ (^|/)(op|pnpm|npm|yarn|bun|uv|bash|sh)([[:space:]]|$) ]]
}

fallback_root() {
    local pid="$1" wt_path="$2" parent command root="$1"
    while true; do
        parent="$(pid_parent "$root")"
        [[ "$parent" =~ ^[0-9]+$ && "$parent" -gt 1 ]] || break
        pid_belongs "$parent" "$wt_path" || break
        command="$(pid_command "$parent")"
        is_launcher_wrapper "$command" || break
        root="$parent"
    done
    echo "$root"
}

valid_saved_root() {
    local pid="$1" started="$2" wt_path="$3"
    [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && [[ -n "$started" && "$(pid_started "$pid")" == "$started" ]] && pid_belongs "$pid" "$wt_path"
}

terminate_verified() {
    local wt_path="$1" candidates="$2" pid verified="" remaining="" i
    candidates="$(printf '%s\n' "$candidates" | sed '/^$/d' | sort -un)"
    [[ -n "$candidates" ]] || return
    echo "Processes selected for termination:"
    while IFS= read -r pid; do
        if pid_belongs "$pid" "$wt_path"; then describe_pid "$pid" | sed 's/^/  /'; verified="${verified}${pid}"$'\n'; fi
    done <<< "$candidates"
    verified="$(printf '%s' "$verified" | sed '/^$/d' | sort -un)"; [[ -n "$verified" ]] || return
    while IFS= read -r pid; do kill -TERM "$pid" 2>/dev/null || true; done <<< "$verified"
    for i in 1 2 3 4 5; do
        remaining=""; while IFS= read -r pid; do kill -0 "$pid" 2>/dev/null && remaining="${remaining}${pid}"$'\n'; done <<< "$verified"
        [[ -z "$remaining" ]] && return; sleep 1
    done
    warn "Verified processes ignored TERM; sending KILL."
    while IFS= read -r pid; do kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true; done <<< "$verified"
}

port_preflight() {
    local service="$1" port="$2" name="$3" wt_path="$4" pid safe=true
    [[ -z "$port" || -z "$(port_pids "$port")" ]] && return
    err "$service port $port is already in use:"
    while IFS= read -r pid; do
        [[ -n "$pid" ]] || continue; describe_pid "$pid" | sed 's/^/  /' >&2
        pid_belongs "$pid" "$wt_path" || safe=false
    done < <(port_pids "$port")
    $safe && err "Safe stop: localhost --stop '$name'" || err "Owner is outside '$wt_path'; it will not be stopped by localhost."
    return 1
}

write_state() {
    local file="$1" wt_path="$2" i pid
    { echo 3; echo "$wt_path"; for ((i=0; i<${#PLAN_SERVICES[@]}; i++)); do
        pid="${PLAN_PIDS[$i]}"
        printf '%s|%s|%s|%s|%s\n' "${PLAN_SERVICES[$i]}" "$pid" "$(pid_started "$pid")" "${PLAN_PORTS[$i]}" "${PLAN_SCOPES[$i]}"
    done; } > "$file"
}

PLAN_PIDS=()
do_launch() {
    local name wt_path file i service dir command port scope op_env env_line env_name env_value log_path pid all_listening
    validate_config; validate_overrides
    name="$(resolve_worktree "$TARGET")"; wt_path="$(worktree_path "$name")"; file="$(state_file "$name")"
    build_plan "$name" "$file" true

    if valid_state "$file" "$wt_path"; then
        local active=false state_service state_pid state_started state_port_value state_scope
        while IFS='|' read -r state_service state_pid state_started state_port_value state_scope; do
            valid_saved_root "$state_pid" "$state_started" "$wt_path" && active=true
            [[ -n "$state_port_value" ]] && port_has_worktree_owner "$state_port_value" "$wt_path" && active=true
        done < <(tail -n +3 "$file")
        $active && { err "'$name' already has an active tracked instance. Run localhost --status '$name'."; exit 1; }
        warn "Removing stale launcher state for '$name'."; rm -f "$file"; build_plan "$name" "$file" true
    fi

    for ((i=0; i<${#PLAN_SERVICES[@]}; i++)); do port_preflight "${PLAN_SERVICES[$i]}" "${PLAN_PORTS[$i]}" "$name" "$wt_path"; done
    PLAN_PIDS=()
    for ((i=0; i<${#PLAN_SERVICES[@]}; i++)); do
        service="${PLAN_SERVICES[$i]}"; port="${PLAN_PORTS[$i]}"; scope="${PLAN_SCOPES[$i]}"
        dir="$wt_path/$(service_get "$service" dir)"; command="$(service_get "$service" command)"; op_env="$(service_get "$service" op-env)"
        [[ -d "$dir" ]] || { err "$service directory not found: $dir"; exit 1; }
        if [[ "$command" == *'{port}'* ]]; then [[ -n "$port" ]] || { err "$service command uses {port}, but no port is configured."; exit 1; }; command="${command//\{port\}/$port}"; fi
        command="$(expand_value "$command" "$name" "$wt_path" "$port")"
        log_path="$(log_dir)/${name}-${service}.log"
        log "Starting $service (${scope}${port:+, :$port}) from $dir"
        (
            runtime_env=()
            while IFS= read -r env_line; do
                [[ -n "$env_line" ]] || continue; [[ "$env_line" == *=* ]] || { err "Invalid $service env '$env_line' (expected NAME=value)."; exit 1; }
                env_name="${env_line%%=*}"; env_value="$(expand_value "${env_line#*=}" "$name" "$wt_path" "$port")"; runtime_env+=("$env_name=$env_value")
            done < <(service_get_all "$service" env)
            [[ -z "$port" ]] || runtime_env+=("PORT=$port")
            if [[ -n "$op_env" ]]; then
                if [[ ${#runtime_env[@]} -gt 0 ]]; then
                    exec python3 "$SCRIPT_DIR/detach.py" "$dir" op run --no-masking --environment "$op_env" -- env "${runtime_env[@]}" bash -lc "$command"
                else
                    exec python3 "$SCRIPT_DIR/detach.py" "$dir" op run --no-masking --environment "$op_env" -- bash -lc "$command"
                fi
            elif [[ ${#runtime_env[@]} -gt 0 ]]; then
                exec python3 "$SCRIPT_DIR/detach.py" "$dir" env "${runtime_env[@]}" bash -lc "$command"
            else
                exec python3 "$SCRIPT_DIR/detach.py" "$dir" bash -lc "$command"
            fi
        ) </dev/null >"$log_path" 2>&1 &
        pid=$!; PLAN_PIDS+=("$pid")
    done
    write_state "$file" "$wt_path"
    rm -f "$(legacy_state_file "$name")"

    for _ in 1 2 3 4 5; do
        all_listening=true
        for ((i=0; i<${#PLAN_SERVICES[@]}; i++)); do
            port="${PLAN_PORTS[$i]}"; [[ -z "$port" || -n "$(port_pids "$port")" ]] || all_listening=false
        done
        $all_listening && break; sleep 1
    done
    local failed=false
    for ((i=0; i<${#PLAN_SERVICES[@]}; i++)); do
        pid="${PLAN_PIDS[$i]}"; port="${PLAN_PORTS[$i]}"
        if ! kill -0 "$pid" 2>/dev/null || [[ -n "$port" && -z "$(port_pids "$port")" ]]; then
            err "${PLAN_SERVICES[$i]} failed to become ready. See $(log_dir)/${name}-${PLAN_SERVICES[$i]}.log"; failed=true
        fi
    done
    if $failed; then do_stop "$name" || true; return 1; fi
    log "Running $name."
    for ((i=0; i<${#PLAN_SERVICES[@]}; i++)); do echo "  ${PLAN_SERVICES[$i]}: ${PLAN_SCOPES[$i]}${PLAN_PORTS[$i]:+ on http://localhost:${PLAN_PORTS[$i]}}"; done
    echo "  Stop: localhost --stop '$name'"
}

do_stop() {
    local target="${1:-$TARGET}" name wt_path file i service port pid line started root tree candidates="" foreign=false dirty remaining=false
    validate_config
    name="$(resolve_worktree "$target")"; wt_path="$(worktree_path "$name")"; file="$(state_file "$name")"
    build_plan "$name" "$file" false
    if valid_state "$file" "$wt_path"; then
        while IFS='|' read -r service pid started port _scope; do
            [[ -n "$service" ]] || continue
            if valid_saved_root "$pid" "$started" "$wt_path"; then tree="$(collect_tree "$pid")"; candidates="${candidates}${tree}"$'\n'; fi
        done < <(tail -n +3 "$file")
    elif [[ -f "$file" ]]; then warn "Ignoring malformed/stale state file: $file"; fi

    local legacy_file legacy_be legacy_fe legacy_be_port legacy_fe_port legacy_pid
    legacy_file="$(legacy_state_file "$name")"
    if [[ -f "$legacy_file" ]]; then
        IFS=',' read -r legacy_be legacy_fe legacy_be_port legacy_fe_port < "$legacy_file" || true
        for legacy_pid in "$legacy_be" "$legacy_fe"; do
            if [[ "$legacy_pid" =~ ^[0-9]+$ ]] && kill -0 "$legacy_pid" 2>/dev/null && pid_belongs "$legacy_pid" "$wt_path" && is_launcher_wrapper "$(pid_command "$legacy_pid")"; then
                tree="$(collect_tree "$legacy_pid")"; candidates="${candidates}${tree}"$'\n'
            fi
        done
    fi

    for ((i=0; i<${#PLAN_SERVICES[@]}; i++)); do
        service="${PLAN_SERVICES[$i]}"; port="${PLAN_PORTS[$i]}"; [[ -n "$port" ]] || continue
        while IFS= read -r pid; do
            [[ -n "$pid" ]] || continue
            if pid_belongs "$pid" "$wt_path"; then root="$(fallback_root "$pid" "$wt_path")"; tree="$(collect_tree "$root")"; candidates="${candidates}${tree}"$'\n'
            else foreign=true; err "Refusing unrelated owner of $service :$port:"; describe_pid "$pid" | sed 's/^/  /' >&2
            fi
        done < <(port_pids "$port")
    done
    if [[ -z "$(printf '%s' "$candidates" | sed '/^$/d')" ]]; then rm -f "$file" "$(legacy_state_file "$name")"; $foreign && return 1; err "No launcher-owned process found for '$name'."; return 1; fi
    dirty="$(git -C "$wt_path" status --short 2>/dev/null || true)"; [[ -n "$dirty" ]] && warn "Worktree has uncommitted files; stopping services will not modify them."
    log "Stopping $name using verified user, worktree, PID-start, and listener ownership."
    terminate_verified "$wt_path" "$candidates"
    for ((i=0; i<${#PLAN_SERVICES[@]}; i++)); do
        port="${PLAN_PORTS[$i]}"; [[ -n "$port" ]] || continue
        while IFS= read -r pid; do [[ -n "$pid" ]] && pid_belongs "$pid" "$wt_path" && { err "PID $pid still owns :$port; state kept."; remaining=true; }; done < <(port_pids "$port")
    done
    $remaining && return 1
    rm -f "$file" "$(legacy_state_file "$name")"; log "Stopped $name and cleared stale launcher state."
    $foreign && return 1; return 0
}

do_status() {
    local name wt_path file i
    validate_config; name="$(resolve_worktree "$TARGET")"; wt_path="$(worktree_path "$name")"; file="$(state_file "$name")"; build_plan "$name" "$file" false
    echo -e "${BOLD}$name${NC}"; echo "  Worktree: $wt_path"
    if valid_state "$file" "$wt_path"; then
        echo "  State: tracked"
    elif [[ -f "$(legacy_state_file "$name")" ]]; then
        echo "  State: legacy (will migrate on stop)"
        local legacy_be legacy_fe legacy_be_port legacy_fe_port legacy_pid
        IFS=',' read -r legacy_be legacy_fe legacy_be_port legacy_fe_port < "$(legacy_state_file "$name")" || true
        for legacy_pid in "$legacy_be" "$legacy_fe"; do
            if [[ "$legacy_pid" =~ ^[0-9]+$ ]] && kill -0 "$legacy_pid" 2>/dev/null; then describe_pid "$legacy_pid" | sed 's/^/    /'; fi
        done
    else
        echo "  State: missing/stale"
    fi
    for ((i=0; i<${#PLAN_SERVICES[@]}; i++)); do describe_port "${PLAN_SERVICES[$i]} (${PLAN_SCOPES[$i]})" "${PLAN_PORTS[$i]}"; done
}

do_list() {
    local path name file i port active state any=false
    validate_config
    echo -e "${BOLD}Localhost services:${NC}"
    while IFS= read -r path; do
        [[ "$path" == "$(main_worktree)" ]] && name=main || name="$(basename "$path")"
        file="$(state_file "$name")"; build_plan "$name" "$file" false; active=false
        for port in "${PLAN_PORTS[@]}"; do
            if [[ -n "$port" ]] && port_has_worktree_owner "$port" "$path"; then active=true; fi
        done
        state=""; if valid_state "$file" "$path"; then state=tracked; fi
        if $active || [[ -n "$state" ]]; then
            any=true; echo "  $name${state:+ ($state)}"
            for ((i=0; i<${#PLAN_SERVICES[@]}; i++)); do describe_port "${PLAN_SERVICES[$i]}" "${PLAN_PORTS[$i]}"; done
        fi
    done < <(worktree_paths)
    $any || echo "  (none)"
}

case "$MODE" in
    launch) do_launch ;;
    stop) do_stop ;;
    status) do_status ;;
    list) do_list ;;
    config) show_config ;;
esac
