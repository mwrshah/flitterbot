---
name: tasks
description: Use the bundled task script to read, mutate, sync, and clean up local tasks
argument-hint: "[task request]"
disable-model-invocation: false
---

This skill helps us use the task system with flitterbot. Local tasks are saved by flitterbot (called local in contrast to external systems like Todoist, and Linear which can be synchronized with) 
Use the bundled script for all actions. Optional Todoist/Linear sync runs only when their API keys are present in config.json.

FIRST THINGS FIRST ON LOAD: has a `periodic_sync_and_cleanup` already run? If it hasn’t, run it now before continuing.

## Supporting Files

See [scripts/tasks.mjs](scripts/tasks.mjs) for the task API script.

## Invocation

Pass one JSON request to the script. Use stdin for large payloads.

```bash
node scripts/tasks.mjs '{"action":"list_tasks","preset":"today"}'
printf '%s\n' '{"action":"create_task","project_name":"Inbox","description":"Follow up"}' | node scripts/tasks.mjs -
node scripts/tasks.mjs --json '{"action":"list_tasks","preset":"today"}'   # JSON output
```

Default output is concise Markdown. Add `--json` / `--format json` / `"format":"json"` for machine output (`{ok, message, ...data}` on success, `{ok:false, error}` on failure).

## Workflow

1. On the first task call in a session, run `periodic_sync_and_cleanup`.
2. Before `create_task`, run `list_tasks` with a relevant filter to avoid duplicates.
3. Use `update_task` to mark a task status as`done`, change due date, move projects, or edit text.
4. Pass `status: "any"` only when the user wants completed tasks included.

## Data Model

- **Project**: `{id, name, archived, externalLinks[], createdAt, updatedAt}`. A task may only be connected to one project.
- **Task**: `{id, projectId, description, details|null, dueAt, status: "active"|"done", externalLinks[], createdAt, updatedAt}`. Output also includes `projectName`. `dueAt` is always set (defaults to today's local midnight if omitted).
- Archived projects + their tasks are hidden unless `include_archived_projects: true`.

## Actions

All actions take `{action, ...}`. Inputs use `snake_case`; stored records use `camelCase`.

### list_projects
- **Input**: `include_archived_projects?: bool`
- **Output**: `{projects: Project[]}`

### create_project
- **Input**: `project_name` (required, unique), `external_links?: ExternalLink[]`
- **Output**: `{project: Project}`
- **Effect**: Calls configured providers to create their side first; resulting provider IDs are stored on the project's `externalLinks`.

### update_project
- **Input**: identify with `project_id` or `project_name_current`. Optional: `project_name` (rename), `project_archived: bool`, `external_links` (full replacement).
- **Output**: `{project: Project}`
- **Effect**: Mirrors changes to configured providers before local write.

### list_tasks
- **Input**:
  - Filters: `project_id?`, `project_name?`, `status?: "active"|"done"|"any"` (default `"active"`), `include_archived_projects?: bool`
  - Range (default `all`): `preset?: "overdue"|"today"|"tomorrow"|"next_days"|"between"|"all"`, `days?` (for `next_days`), `start_date`/`end_date` (date-inclusive `between`), `start_at`/`end_at` (datetime-inclusive `between`)
- **Output**: `{tasks: Task[]}` sorted by due date

### get_task
- **Input**: `task_id` (required)
- **Output**: `{task: Task}`

### create_task
- **Input**: `description` (required); project via `project_id` or `project_name` (auto-creates if missing; defaults to `"Inbox"`); `details?`, `due_at?` (ISO date or datetime), `due_in_days?: number`, `external_links?: ExternalLink[]`
- **Output**: `{task: Task}`
- **Effect**: Creates upstream in configured providers first, stores returned IDs on `externalLinks`.

### update_task
- **Input**: `task_id` (required). Any of: `description`, `details` (null clears), `due_at` or `due_in_days`, `status: "active"|"done"`, `project_id`/`project_name` (move), `external_links` (full replacement).
- **Output**: `{task: Task}`
- **Effect**: Pushes patch to configured providers first.
- **Conflict**: If a provider's `updated_at` is newer than local `updatedAt`, the call fails and nothing is written. Run `periodic_sync_and_cleanup` to pull, then retry.

### periodic_sync_and_cleanup
- **Input**: `cleanup_days?: number` (default 90), `completed_since?`/`completed_until?` (override Todoist completion window)
- **Output**: `{todoist, linear, cleanup}` with per-provider inbound counts and removed-task count
- **Effects**:
  - **Cleanup**: deletes local `done` tasks whose `updatedAt` is older than `cleanup_days`. Local-only; never propagates upstream.
  - **Todoist inbound**: pulls active projects/tasks (create or update local); completed Todoist tasks only mark already-existing local tasks `done` — they never create new local tasks.
  - **Linear inbound**: pulls issues assigned to the API user from teams linked to active local projects. Active issues create/update local tasks; completed/canceled only mark existing local tasks `done`.
  - **Conflict guard**: if both providers have a newer upstream version of the same local record in one run, the action errors out instead of overwriting.
  - **Skip behavior**: missing provider key → that provider quietly skips inward; cleanup still runs.
  - **Migration**: silently upgrades old external-link shapes with a `.pre-external-links-migration-*.bak` backup beside the data file.

## External Links

Provider links live on `externalLinks[]`. One entry per system.

```jsonc
// Project links
{ "system": "todoist", "projectId": "..." }
{ "system": "linear",  "teamId": "...", "projectId": null }   // teamId required; projectId optional

// Task links
{ "system": "todoist", "taskId": "...",  "url"?: "..." }
{ "system": "linear",  "issueId": "...", "url"?: "..." }
```

## Provider Gating

- Config at `~/.flitterbot/config.json`. Sync runs only for providers whose key is present:
  ```json
  { "todoistApiKey": "...", "linearApiKey": "..." }
  ```
- **Todoist**: enabled globally when `todoistApiKey` is set. Subprojects flatten to local project names.
- **Linear**: per-project. Only local projects whose `externalLinks` contain `{system:"linear", teamId}` sync. Without a team link, Linear is silently inert for that project.
- Local project name is appended to outbound Linear issue descriptions as `[proj_name-<local project>]`.
- Linear status mapping: local `active` ↔ first `unstarted` Linear state; local `done` ↔ first `completed` state. Inbound `completed`/`canceled` → local `done`; everything else → local `active`.
- Linear outbound never creates new issues for tasks already `done` locally. Todoist recurring-task completion sync-out is disabled — complete recurring tasks in Todoist, then run `periodic_sync_and_cleanup`.

## Response Style

Report the task/project changed and include the short ID when useful.
