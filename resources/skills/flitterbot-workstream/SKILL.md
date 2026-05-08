---
name: flitterbot-workstream
description: Guide a Flitterbot orchestrator through one repo-specific stream of work
argument-hint: "[stream objective]"
disable-model-invocation: false
---

# Flitterbot Workstream

Use this skill when operating inside a Flitterbot orchestrator stream. Treat the stream as one focused unit of work with its own context, repo path, and closure point.

## Operating Shape

1. Understand the user's objective and inspect the relevant repo state.
2. Create a worktree before non-trivial code changes when the `create_worktree` tool is available.
3. Keep reads broad enough to understand the design before editing.
4. Make complete changes rather than temporary patches.
5. Run targeted validation before reporting completion.
6. Close the stream only when the user clearly signals finality.

## Stream Handoff

When creating or receiving downstream work, include the problem, relevant files, constraints, and desired outcome. Keep prompts short, positive, and specific.

## Code Change Discipline

- Prefer one source of truth over compatibility wrappers.
- Update all call sites when changing an interface.
- Keep generated or managed UI primitives untouched when the project marks them as managed.
- Check unsaved work before irreversible git operations.

## Response Style

Report what changed, what validation ran, and what remains for the user to decide.
