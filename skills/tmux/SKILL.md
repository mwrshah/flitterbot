---
name: tmux
description: Manage Claude Code or Codex across up to 50 tmux sessions (one per terminal window, tiled by WM)
argument-hint: "[status|launch|quit|send|message] [session] [args] [--agent-command command]"
---

# tmux — Separate Sessions Workstation

Manage up to 50 Claude Code or Codex instances, each in its own tmux session (`a` through `z`, then `aa` through `ax`). Sessions are created automatically as detached tmux sessions when needed. To watch a session, you can instruct the user to attach from any terminal: `tmux attach -t <S>`.

## Invocation

`<skill-dir-path>` is the path from the injected `References are relative to` line.

```bash
/bin/bash "<skill-dir-path>/scripts/sessions.sh" <command>
```

## Instructions

$ARGUMENTS

With no arguments, run `status`.

Sessions are identified by name: single letters `a`–`z`, then two-letter names `aa`–`ax` (50 total). The user may say "session a", "terminal a", "tmux a", or just "a" — all mean the same thing. Auto-select is the standard way to launch — the script picks the first free session via queuing. Users should NOT specify a session name manually.

All commands run through the invocation above.

### Rules

When deciding to launch multiple tmux sessions, consider whether the work can split naturally into independent, scoped questions or slices; otherwise, keep it in the current session.

1. **Launch the agent with `sessions.sh launch`** — never raw tmux. The script sets required env vars (`FLITTERBOT_AGENT_MANAGED=1` etc.). Without them, stop hooks won't fire. If launch fails, report the error.

2. **Send prompts with `message`, not `send`.** `message` verifies the agent started inferring and retries if needed. Use `send` only for raw keystrokes (bare Enter to accept a prompt, typing a shell command).

3. **Always use auto-select for launch** — do NOT specify a session letter. Let the script pick a free session. The output line `Launched in session X (ready)` tells you which session was assigned — parse it to know where to send subsequent `message`/`send`/`read` commands.

4. **Respect an explicit harness override.** When the user specifies `--harness codex` or `--harness claude`, preserve that flag in the launch command; the explicit choice takes precedence over configuration. When the user does not specify a harness, omit `--harness` so the script uses the configured default automatically.

5. **Respect a custom agent command.** When the user names a shell alias, function, or wrapper for the agent (for example, `codexy`), pass it as `--agent-command <command>` with the matching `--harness`. Ask which harness it wraps if that is ambiguous. Flitterbot still adds its managed environment and standard permission flags. Wrapper scripts must `exec` the underlying agent so session detection can find it.

6. **Never sleep or poll to wait for a session to finish.** Rely on the user prompting you again or a hook callback delivering the completion notification.
7. If a stopped tmux-launched agent says it launched or is waiting on a downstream/background agent/workflow (keywords like “running in the background”, “Dynamic Workflow”, or “background agent”), do nothing; let it finish and expect another stop hook with its result.

### Commands

In examples below, `<S>` is any valid session name (a–z, aa–ax). Substitute the actual session you're targeting:
```
# Example: to message a session
/bin/bash "<skill-dir-path>/scripts/sessions.sh" message <S> "run the tests"
```

**Status** — agent state for all tmux sessions:

- `FREE`: no process occupies the tmux slot.
- `IDLE`: an agent occupies the slot and can receive another prompt.
- `INFERRING`: the agent is working.
- `BUSY (other)`: a non-agent process occupies the slot.
- `NOT RUNNING`: the tmux session does not exist.

```bash
/bin/bash "<skill-dir-path>/scripts/sessions.sh" status
```

**State** — the same state model for one or all sessions. Omit `<S>` for all sessions, or pass it for one session.

```bash
/bin/bash "<skill-dir-path>/scripts/sessions.sh" state
/bin/bash "<skill-dir-path>/scripts/sessions.sh" state <S>
```

**Launch** — auto-selects a free session (or reclaims longest-idle). ALWAYS use this form. Output is `Launched in session e (ready)` — parse it to get the session letter.

```bash
/bin/bash "<skill-dir-path>/scripts/sessions.sh" launch ~/project
/bin/bash "<skill-dir-path>/scripts/sessions.sh" launch ~/project --pi-session-id abc --stream-id def
/bin/bash "<skill-dir-path>/scripts/sessions.sh" launch ~/Documents/coded-programs/Surtr-worktrees/057-finops-invoices-cron --harness codex
/bin/bash "<skill-dir-path>/scripts/sessions.sh" launch ~/project --harness codex --agent-command codexy
/bin/bash "<skill-dir-path>/scripts/sessions.sh" launch ~/project --harness claude //skip --harness unless specified by the user
```

**Quit**

```bash
/bin/bash "<skill-dir-path>/scripts/sessions.sh" quit <S>
```

**Message** — reprompt an existing idle agent, then verify inference started (preferred over send).

```bash
/bin/bash "<skill-dir-path>/scripts/sessions.sh" message <S> "fix the login bug"
```

**Send** — raw keystrokes only (bare Enter for permission prompts, shell commands). The second form sends a bare Enter.

```bash
/bin/bash "<skill-dir-path>/scripts/sessions.sh" send <S> "text here"
/bin/bash "<skill-dir-path>/scripts/sessions.sh" send <S>
```

**Other** — `clear` resets the agent's conversation, `read` captures screen contents, `session-id` prints the harness session UUID.

```bash
/bin/bash "<skill-dir-path>/scripts/sessions.sh" clear <S>
/bin/bash "<skill-dir-path>/scripts/sessions.sh" read <S>
/bin/bash "<skill-dir-path>/scripts/sessions.sh" session-id <S>
```

### Behavior

- Sessions are persistent (survive terminal close). Reattach: `tmux attach -t a`.
- `launch` auto-selects the first free session, or reclaims the longest-idle one.
- `message` refuses to send while a session is inferring.
