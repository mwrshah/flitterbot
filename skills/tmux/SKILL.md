---
name: tmux
description: Manage Claude Code across up to 50 tmux sessions (one per terminal window, tiled by WM)
argument-hint: "[status|launch|quit|send|message] [session] [args]"
---

# tmux — Separate Sessions Workstation

Manage up to 50 Claude Code instances, each in its own tmux session (`a` through `z`, then `aa` through `ax`). Sessions are created automatically as detached tmux sessions when needed. To watch a session, you can instruct the user to attach from any terminal: `tmux attach -t <S>`.

## Supporting Files

- [scripts/sessions.sh](scripts/sessions.sh) — Session management script

## Instructions

$ARGUMENTS

With no arguments, run `status`.

Sessions are identified by name: single letters `a`–`z`, then two-letter names `aa`–`ax` (50 total). The user may say "session a", "terminal a", "tmux a", or just "a" — all mean the same thing. Auto-select is the standard way to launch — the script picks the first free session via queuing. Users should NOT specify a session name manually.

All commands run via `/bin/bash scripts/sessions.sh <command>` relative to the skill directory.

### Rules

1. **Launch Claude with `sessions.sh launch`** — never raw tmux. The script sets required env vars (`AUTONOMA_AGENT_MANAGED=1` etc.). Without them, stop hooks won't fire. If launch fails, report the error.

2. **Send prompts with `message`, not `send`.** `message` verifies Claude started inferring and retries if needed. Use `send` only for raw keystrokes (bare Enter to accept a prompt, typing a shell command).

3. **Always use auto-select for launch** — do NOT specify a session letter. Let the script pick a free session. The output line `Launched in session X (ready)` tells you which session was assigned — parse it to know where to send subsequent `message`/`send`/`read` commands.

4. **Never sleep or poll to wait for a session to finish.** Rely on the user prompting you again or a hook callback delivering the completion notification.

### Commands

In examples below, `<S>` is any valid session name (a–z, aa–ax). Substitute the actual session you're targeting:
```
# Example: to message a session
/bin/bash scripts/sessions.sh message <S> "run the tests"
```

```bash
# Status — process-level view of each session: FREE, BUSY (claude), BUSY (process), NOT RUNNING
/bin/bash scripts/sessions.sh status

# State — Claude UI state: IDLE (duration), INFERRING, FREE (duration), NOT RUNNING
/bin/bash scripts/sessions.sh state               # all sessions
/bin/bash scripts/sessions.sh state <S>           # single session

# Launch — auto-selects a free session (or reclaims longest-idle). ALWAYS use this form.
/bin/bash scripts/sessions.sh launch ~/project
/bin/bash scripts/sessions.sh launch ~/project --pi-session-id abc --stream-id def
# Output: "Launched in session e (ready)" — parse this to get the session letter.
# Fallback: explicit session letter (rarely needed)
/bin/bash scripts/sessions.sh launch <S> ~/project

# Quit
/bin/bash scripts/sessions.sh quit <S>

# Message — send a prompt to Claude, then verify inference started (preferred over send)
/bin/bash scripts/sessions.sh message <S> "fix the login bug"

# Send — raw keystrokes only (bare Enter for permission prompts, shell commands)
/bin/bash scripts/sessions.sh send <S> "text here"
/bin/bash scripts/sessions.sh send <S>            # bare Enter

# Other
/bin/bash scripts/sessions.sh clear <S>           # reset Claude conversation
/bin/bash scripts/sessions.sh read <S>            # capture screen contents
/bin/bash scripts/sessions.sh session-id <S>      # Claude Code session UUID
```

### Behavior

- Sessions are persistent (survive terminal close). Reattach: `tmux attach -t a`.
- `launch` auto-selects the first free session, or reclaims the longest-idle one.
- `message` refuses to send while a session is inferring.
