---
name: flitterbot-tasks
description: Use Flitterbot's bundled task script to read and mutate local tasks
argument-hint: "[task request]"
disable-model-invocation: false
---

# Flitterbot Tasks

Use Flitterbot's bundled task script for all task reads and mutations. Treat task storage as an implementation detail owned by the script.

## Supporting Files

See [scripts/tasks.mjs](scripts/tasks.mjs) for the task API script.

## Interface

Run the bundled script with a JSON request. References are relative to this skill directory.

```bash
node scripts/tasks.mjs '{"action":"list_tasks","preset":"today"}'
```

For longer payloads, pipe JSON on stdin:

```bash
printf '%s\n' '{"action":"create_task","project_name":"Inbox","description":"Follow up","due_at":"2026-05-10"}' | node scripts/tasks.mjs -
```

The script returns JSON with `ok`, `message`, and action-specific data.

Supported actions:

- `list_projects`
- `create_project`
- `update_project`
- `list_tasks`
- `get_task`
- `create_task`
- `update_task`

## Data Model

- A project has `id`, `name`, and `archived`.
- A task belongs to exactly one project.
- A task has `description` as its primary task text.
- A task always has `due_at`; if no due input is provided, the script resolves it to today.
- A task may have `details` and generic `external_links` for future Linear/Todoist/etc. sync.
- Task status is `active` or `done`.
- Archived projects and their tasks are hidden from normal queries unless explicitly requested.

## Query Primitive

All due-date queries use the script's range primitive:

- `overdue`
- `today`
- `tomorrow`
- `next_days` with `days`
- `between` with `start_date`/`end_date` or `start_at`/`end_at`
- `all`

Date-only ranges are inclusive by date. Datetime ranges are inclusive by timestamp.

## Workflow

1. Before creating a task, call the script with `action: "list_tasks"` and a relevant filter to avoid duplicates.
2. Use `create_project` only when no existing project fits.
3. Use `create_task` for new tasks and `update_task` to mark done, change due date, move projects, or edit text/details.
4. Use `status: "any"` only when the user asks to search completed tasks too.
5. Keep all task reads and mutations going through the script.

## Response Style

Report the task/project changed and include user-meaningful IDs when useful. Talk about the task API/script, not its storage.
