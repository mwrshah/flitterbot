---
name: flitterbot-tasks
description: Understand Flitterbot's SQLite-backed local task system
argument-hint: "[task request]"
disable-model-invocation: false
---

# Flitterbot Tasks

Flitterbot's task system is backed by SQLite and lives outside the agent custom-tool surface.

## Source of Truth

- SQLite DB: `~/.flitterbot/tasks.db`
- Generated JSON projection: `~/.flitterbot/tasks/tasks.json`
- Generated Markdown projection: `~/.flitterbot/tasks/active.md`
- Implementation module: `src/tasks/db.ts`

SQLite owns the data. JSON and Markdown are generated projections. Treat Markdown as readable/editable by humans, but do not sync Markdown edits back into SQLite.

## Data Model

- A project has `id`, `name`, and `archived`.
- A task belongs to exactly one project.
- A task has `description` as its primary task text.
- A task always has `dueAt`; if no due input is provided, the API resolves it to today.
- A task may have `details` and generic `externalLinks` for future Linear/Todoist/etc. sync.
- Task status is `active` or `done`.
- Archived projects and their tasks are hidden from normal queries and exports.

## Query Primitive

All due-date queries reduce to the same range primitive in the task DB layer:

- `overdue`
- `today`
- `tomorrow`
- `next_days` with `days`
- `between` with `start_date`/`end_date` or `start_at`/`end_at`
- `all`

Date-only ranges are inclusive by date. Datetime ranges are inclusive by timestamp.

## Agent Guidance

Use this skill for task-system context and conventions. The task database is not exposed as a Flitterbot custom tool; avoid inventing task tool calls. When code changes are requested, edit the task module and its call sites. When the user asks to manage real tasks through chat, explain that the task API needs a non-agent surface (CLI, HTTP route, or UI action) before agents can safely mutate it.

## Response Style

Be explicit about whether you are describing the task system, changing its implementation, or saying that no agent-facing mutation surface exists yet.
