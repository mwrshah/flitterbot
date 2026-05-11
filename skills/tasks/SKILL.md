---
name: tasks
description: Use the bundled task script to read and mutate local tasks
argument-hint: "[task request]"
disable-model-invocation: false
---

# Tasks

Use the bundled task script for all task reads and mutations. Treat task storage as an implementation detail owned by the script.

## Supporting Files

See [scripts/tasks.mjs](scripts/tasks.mjs) for the task API script. Provider orchestration lives in [scripts/integrations.mjs](scripts/integrations.mjs); Todoist inbound/outbound sync lives in [scripts/todoist-provider.mjs](scripts/todoist-provider.mjs).

## Interface

Run the bundled script with a JSON request. References are relative to this skill directory.

```bash
node scripts/tasks.mjs '{"action":"list_tasks","preset":"today"}'
```

Default output is concise Markdown/text for model and human consumption:

```text
Found 2 tasks.

- `Q4v9aP0mNz` [Inbox] Follow up — due 2026-05-10
- `B7kLm2xTq1` [Work] Send launch notes — due 2026-05-12 14:30
```

For longer payloads, pipe JSON on stdin:

```bash
printf '%s\n' '{"action":"create_task","project_name":"Inbox","description":"Follow up","due_at":"2026-05-10"}' | node scripts/tasks.mjs -
```

Use JSON only when a caller needs machine-readable output:

```bash
node scripts/tasks.mjs --json '{"action":"list_tasks","preset":"today"}'
# or include "format":"json" in the request payload
```

JSON output includes `ok`, `message`, and action-specific data.

Supported actions:

- `list_projects`
- `create_project`
- `update_project`
- `list_tasks`
- `get_task`
- `create_task`
- `update_task`
- `maintain_tasks`
- `sync_todoist`
- `sync_linear`

## Data Model

- A project has `id`, `name`, `archived`, and optional hidden `external_links`.
- A task belongs to exactly one project.
- A task has `description` as its primary task text.
- A task always has `due_at`; if no due input is provided, the script resolves it to today.
- A task may have `details` and provider-specific `external_links` for first-class mappings such as Todoist and Linear.
- Task status is `active` or `done`.
- Archived projects and their tasks are hidden from normal queries unless explicitly requested.
- Todoist subprojects are flattened locally as plain local project names; Todoist project IDs/parent metadata stay hidden in `external_links`.

## Query Primitive

All due-date queries use the script's range primitive:

- `overdue`
- `today`
- `tomorrow`
- `next_days` with `days`
- `between` with `start_date`/`end_date` or `start_at`/`end_at`
- `all`

Date-only ranges are inclusive by date. Datetime ranges are inclusive by timestamp.

## Integration Gating

Provider sync is enabled only by flat integration proof in `~/.flitterbot/config.json`; to enable it, add `todoistApiKey` or `linearApiKey` there.

Linear requires per-local-project routing, because Linear issues must belong to a team and local projects are not inherently Linear teams/projects. Store that mapping as the Linear project external link, not in config:

```json
{
  "id": "local-project-id",
  "name": "Local Project Name",
  "externalLinks": [
    { "system": "todoist", "projectId": "todoist-project-id" },
    { "system": "linear", "teamId": "linear-team-id", "projectId": "optional-linear-project-id" }
  ]
}
```

Task links use `{ "system": "todoist", "taskId": "..." }` and `{ "system": "linear", "issueId": "..." }`. If a provider key or local project mapping is absent, sync and outbound provider mutation quietly do not run for that provider/project. Todoist and Linear links are first-class in the data model. Add new providers by registering them in `scripts/integrations.mjs` and keeping provider-specific read/write logic in their own `scripts/*-provider.mjs` file.

## Maintenance and Sync Rules

- Run maintenance once when `/skill:tasks` is first loaded/used in an agent session, before normal task reads or mutations:

```bash
node scripts/tasks.mjs '{"action":"maintain_tasks"}'
```

- Maintenance always removes local `done` tasks whose local `updatedAt` is more than 90 days old. Status changes update `updatedAt`, so no separate local completion timestamp is stored. This deletion is local-only and is never synced upstream to Todoist or Linear.
- Maintenance also runs configured provider inbound sync. Missing provider keys quietly skip sync while cleanup still runs.
- Maintenance snapshots every local record's `updatedAt` before provider sync starts. Todoist and Linear inbound comparisons both use that snapshot, so one provider syncing inward cannot hide a concurrent upstream change in the other provider.
- Maintenance also persists the external-link shape migration when it sees old `externalId` links or old top-level Linear project fields. Before the migration write, it creates a same-directory `tasks.json.pre-external-links-migration-*.bak` backup.
- Inbound sync compares the provider record's `updated_at`/`updatedAt` to the snapshotted local `updatedAt`. If upstream is not newer, sync leaves the local task/project untouched. Provider update timestamps are not stored locally.
- If two providers both have newer upstream versions for the same local record in one maintenance run, maintenance fails instead of letting the second provider overwrite the first.
- Do not run maintenance periodically after that inside the same agent session. New skill invocations/sessions are the periodic boundary.

## Todoist Sync Rules
- Inbound sync imports active Todoist tasks and updates existing local tasks from completed Todoist history. Completed Todoist tasks are never imported as new local tasks; they only mark an already-local linked or project+description-matched task `done`. `completed_days` defaults to 90, and `completed_since`/`completed_until` can override the completion window.
- Outbound mutation: Flitterbot wins only if Todoist is not newer than the local record. If Todoist `updated_at` is newer than local `updatedAt`, the mutation fails and local data is not changed; run maintenance/sync first.
- Todoist recurring task completion is intentionally disabled for sync-out. Complete recurring tasks in Todoist, then run `sync_todoist`.
- Local `create_task`, `update_task`, `create_project`, and `update_project` auto-mutate configured providers before local write.

## Linear Sync Rules

- Linear issues map to local tasks; Linear teams/projects do not map automatically to local projects.
- A local project syncs to Linear only when its project `externalLinks` contains `{ "system": "linear", "teamId": "..." }`. Optional `projectId` assigns created/updated issues to a Linear Project.
- Local project name is appended to Linear issue descriptions as `[proj_name-<local project>]`.
- Linear workflow statuses are team-specific, but local sync only uses Linear status categories. Local `active` maps to the first `unstarted` state; local `done` maps to the first `completed` state. Inbound Linear `completed` and `canceled` issues become local `done`; all other Linear states become local `active`.
- Linear inbound sync pulls issues assigned to the current Linear API user from teams linked to active local projects. Active issues may create/update local tasks. Completed/canceled Linear issues never create new local tasks; they only mark an already-local linked or project+description-matched task `done`.
- Linear wins on inbound sync when Linear `updatedAt` is newer than local `updatedAt`. Outbound local mutation fails if the Linear issue `updatedAt` is newer than local `updatedAt`.
- Local due dates map to Linear `dueDate`.
- Linear outbound sync does not create new Linear issues for already-completed local tasks. Existing linked Linear issues can still be marked complete when the local task is completed.

## Workflow

1. On first use in the agent session, run `maintain_tasks` once; cleanup always runs, configured provider sync runs, and missing provider keys quietly skip.
2. Before creating a task, call the script with `action: "list_tasks"` and a relevant filter to avoid duplicates.
3. Use `create_project` only when no existing project fits.
4. Use `create_task` for new tasks and `update_task` to mark done, change due date, move projects, or edit text/details.
5. Use `status: "any"` only when the user asks to search completed tasks too.
6. Keep all task reads and mutations going through the script.

## Response Style

Report the task/project changed and include user-meaningful IDs when useful. Talk about the task API/script, not its storage.
