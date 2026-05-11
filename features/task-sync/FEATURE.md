# Task Sync E2E Test Plan

## Goal

Prove the task sync design works end-to-end across local tasks, Todoist, Linear, and maintenance cleanup.

This plan focuses on observable behavior, not implementation details. Each test should use a disposable Todoist project, a disposable Linear team/project mapping, and a temporary local task store unless explicitly testing the real store.

## Test Environment

Use a temporary task store:

```bash
export FLITTERBOT_TASKS_FILE="$(mktemp -d)/tasks.json"
export FLITTERBOT_CONFIG="$(mktemp)"
```

Use flat config keys only:

```json
{
  "todoistApiKey": "...",
  "linearApiKey": "..."
}
```

Use one local project mapped to Linear:

```bash
node skills/tasks/scripts/tasks.mjs --json '{
  "action": "create_project",
  "project_name": "Task Sync E2E",
  "external_links": [
    { "system": "linear", "teamId": "<linear-team-id>", "projectId": "<optional-linear-project-id>" }
  ]
}'
```

Primary maintenance entrypoint:

```bash
node skills/tasks/scripts/tasks.mjs --json '{"action":"maintain_tasks"}'
```

## Invariants to Check Throughout

- Local tasks store only essential task fields: no `completedAt`, no provider timestamp snapshots.
- Provider links stay minimal and provider-specific: Todoist uses `projectId`/`taskId`; Linear uses project-level `teamId`/`projectId` and task-level `issueId`; task links may include `url`.
- Missing provider keys quietly skip sync while cleanup still runs.
- Inbound sync compares provider `updated_at` / `updatedAt` against the local `updatedAt` snapshot captured at the start of the maintenance run.
- If Todoist and Linear are both newer than the same local task snapshot in one maintenance run, maintenance errors instead of silently choosing one provider.
- Local cleanup deletes old local `done` tasks only; it never deletes or completes upstream provider tasks.

## Core E2E Cases

### 1. First maintenance with no provider config

Setup:
- Config has empty or missing `todoistApiKey` and `linearApiKey`.
- Local store has one active task and one old completed task where `status = "done"` and `updatedAt` is older than 90 days.

Action:
- Run `maintain_tasks`.

Expected:
- Todoist sync reports skipped.
- Linear sync reports skipped.
- Old completed local task is removed.
- Active task remains.
- No upstream API calls are required.

### 2. First Todoist inbound sync

Setup:
- Config has `todoistApiKey` only.
- Todoist has a disposable active task in project `Task Sync E2E`.
- Local store has no matching task.

Action:
- Run `maintain_tasks`.

Expected:
- Todoist project is created/linked locally if absent.
- Todoist task is created locally as `active`.
- Local task gets a Todoist external link.
- Local `updatedAt` is set to sync time.
- Linear is skipped.

### 3. First Linear inbound sync

Setup:
- Config has `linearApiKey` only.
- Local project has a Linear external link with `teamId` and optional `projectId`.
- Linear has an assigned issue in that team/project.
- Local store has no matching task.

Action:
- Run `maintain_tasks`.

Expected:
- Linear issue is created locally as a task.
- Local status is `active` unless Linear state type is `completed` or `canceled`.
- Local task gets a Linear external link.
- Local project mapping remains on the Linear project external link.

### 4. Local create task with both providers configured

Setup:
- Config has both keys.
- Local project exists and has a Linear external link with `teamId`.

Action:
- Run `create_task` for project `Task Sync E2E`.

Expected:
- Todoist task is created first, then local stores Todoist external ID.
- Linear issue is created first, then local stores Linear external ID.
- Local task is written only after successful provider creation.
- Linear issue starts in the first `unstarted` workflow state.
- Local due date maps to Todoist due date and Linear `dueDate`.

### 5. Local update existing task

Setup:
- Local task is linked to Todoist and Linear.
- Upstream Todoist `updated_at` and Linear `updatedAt` are not newer than local `updatedAt`.

Action:
- Run `update_task` changing description, details, due date, or project.

Expected:
- Todoist is updated remote-first.
- Linear is updated remote-first.
- Local task is updated after providers succeed.
- Local `updatedAt` advances.
- Provider links remain minimal.

### 6. Local complete task

Setup:
- Local active task is linked to Todoist and Linear.
- Todoist task is non-recurring.
- Upstream records are not newer than local.

Action:
- Run `update_task` with `status: "done"`.

Expected:
- Todoist task is completed.
- Linear issue moves to first `completed` workflow state.
- Local status becomes `done`.
- Local `updatedAt` advances and is the completion timestamp for retention purposes.
- No local `completedAt` field is written.

### 7. Todoist recurring completion guard

Setup:
- Local active task is linked to a recurring Todoist task.

Action:
- Run `update_task` with `status: "done"`.

Expected:
- Action fails.
- Local task is not changed.
- Linear should not be left completed if Todoist fails; verify remote-first/provider ordering does not create split state.
- User should complete recurring task in Todoist, then run maintenance.

### 8. Restore completed task to active

Setup:
- Local task is `done` and linked to Todoist.

Action:
- Run `update_task` with `status: "active"`.

Expected:
- Action fails for Todoist-linked tasks.
- Local task remains `done`.
- User should restore in Todoist, then run maintenance.

## Inbound Change Cases

### 9. Todoist changed first, then maintenance

Setup:
- Local task linked to Todoist.
- Modify task in Todoist after local `updatedAt`.

Action:
- Run `maintain_tasks`.

Expected:
- Todoist `updated_at` is newer than snapshotted local `updatedAt`.
- Todoist wins inbound.
- Local fields mirror Todoist.
- Local `updatedAt` advances to maintenance time.

### 10. Linear changed first, then maintenance

Setup:
- Local task linked to Linear.
- Modify issue in Linear after local `updatedAt`.

Action:
- Run `maintain_tasks`.

Expected:
- Linear `updatedAt` is newer than snapshotted local `updatedAt`.
- Linear wins inbound.
- Local fields mirror Linear.
- Local `updatedAt` advances to maintenance time.

### 11. Todoist changed first, then local update without maintenance

Setup:
- Local task linked to Todoist.
- Modify Todoist task so Todoist `updated_at` is newer than local `updatedAt`.

Action:
- Run local `update_task`.

Expected:
- Action fails before local write.
- Error tells user to run maintenance/sync first.
- Local JSON remains unchanged.
- Linear should not be mutated if Todoist conflict is detected first.

### 12. Linear changed first, then local update without maintenance

Setup:
- Local task linked to Linear.
- Modify Linear issue so Linear `updatedAt` is newer than local `updatedAt`.

Action:
- Run local `update_task`.

Expected:
- Action fails before local write.
- Error tells user to run maintenance/sync first.
- Local JSON remains unchanged.

### 13. Todoist and Linear both changed before one maintenance run

Setup:
- Local task is linked to both providers.
- Record local `updatedAt`.
- Modify Todoist after that timestamp.
- Modify Linear after that timestamp.

Action:
- Run `maintain_tasks`.

Expected:
- Maintenance snapshots local `updatedAt` before any provider sync.
- Todoist is detected as newer than the snapshot.
- Linear is also detected as newer than the same snapshot, even if Todoist synced first and advanced local `updatedAt`.
- Maintenance fails with a conflict instead of overwriting one provider with the other.
- The test should verify whether partial local writes happen before the conflict; if they do, decide whether to add transactional rollback.

### 14. Provider unchanged during maintenance

Setup:
- Local task linked to provider.
- Provider `updated_at` / `updatedAt` is equal to or older than local `updatedAt`.

Action:
- Run `maintain_tasks` twice.

Expected:
- Second run does not rewrite local task/project.
- Top-level store `updatedAt` does not advance on a no-op maintenance run.
- No task fields change.

## 90-Day Retention and Re-Creation Cases

### 15. Local completed task older than 90 days is archived locally

Setup:
- Local task has `status: "done"` and `updatedAt` older than 90 days.
- Task may have Todoist and/or Linear links.

Action:
- Run `maintain_tasks`.

Expected:
- Local task is removed from JSON.
- No provider deletion/completion/archive mutation occurs.

### 16. Old completed Todoist task does not reappear after cleanup

Setup:
- Todoist has a completed task older than 90 days.
- Local linked copy was removed by cleanup.

Action:
- Run `maintain_tasks`.

Expected:
- Todoist completed history query only considers last 90 days by default.
- Old completed Todoist task is not recreated locally.

### 17. Old completed Linear issue does not reappear after cleanup

Setup:
- Linear issue is completed/canceled older than 90 days.
- Local linked copy was removed by cleanup.

Action:
- Run `maintain_tasks`.

Expected:
- Linear completed/canceled issue is filtered out by completed cutoff.
- Old completed Linear issue is not recreated locally.

### 18. Recently completed provider task can sync inward

Setup:
- Todoist or Linear task was completed within the last 90 days.
- Local task is absent or active and linked.

Action:
- Run `maintain_tasks`.

Expected:
- Provider completion syncs inward.
- Local task status becomes `done`.
- Local `updatedAt` is set to sync time.
- It remains locally visible only when querying `status: "done"` or `status: "any"`.

### 19. Cleanup does not delete active stale tasks

Setup:
- Local task has `status: "active"` and `updatedAt` older than 90 days.

Action:
- Run `maintain_tasks`.

Expected:
- Task remains local.
- Retention applies only to `done` tasks.

## Project Mapping Cases

### 20. Linear key present, project has no Linear external link

Setup:
- Config has `linearApiKey`.
- Local project has no Linear external link with `teamId`.

Action:
- Create or update a local task in that project.

Expected:
- Linear does nothing for that project.
- Todoist still runs if configured.
- Local write succeeds.

### 21. Add Linear `teamId` to an existing project

Setup:
- Local project has existing unlinked local tasks.
- Update project with Linear `teamId`.

Action:
- Run `maintain_tasks`.

Expected:
- Linear inbound sync begins for assigned issues in that team.
- Existing local tasks are not bulk-created in Linear merely because the project gained a Linear `teamId`.
- Existing local tasks sync outward only when individually created or updated after mapping exists.

### 22. Add Linear `projectId`

Setup:
- Local project has a Linear `teamId`.
- Update project with Linear `projectId`.

Action:
- Create a new local task.

Expected:
- Linear issue is created in the team and assigned to the Linear Project.
- Inbound Linear issues with that `projectId` map back to the local project.

## Todoist Project Cases

### 23. Todoist project create/update

Setup:
- Config has `todoistApiKey`.

Action:
- Run local `create_project`, then `update_project` rename/archive/unarchive.

Expected:
- Todoist project is created/updated remote-first.
- Local project stores minimal Todoist link.
- If Todoist project changed upstream first, local update fails.

### 24. Todoist duplicate flattened project names

Setup:
- Todoist has two active projects whose names collide after local normalization.

Action:
- Run `maintain_tasks`.

Expected:
- Maintenance fails with a clear duplicate flattened project-name error.
- Local store is not silently merged incorrectly.

## Status Mapping Cases

### 25. Linear status inbound mapping

Setup:
- Linear issues in states of type `backlog`, `unstarted`, `started`, `completed`, and `canceled`.

Action:
- Run `maintain_tasks`.

Expected:
- `completed` and `canceled` become local `done`.
- `backlog`, `unstarted`, and `started` become local `active`.

### 26. Linear status outbound mapping

Setup:
- Local active and done tasks linked to Linear.

Action:
- Update active task; complete another task.

Expected:
- Active task uses first Linear `unstarted` state, falling back to `backlog` only if no unstarted state exists.
- Done task uses first Linear `completed` state.
- Due date remains a due date only; no special `Today` state behavior.

### 27. Todoist status mapping

Setup:
- Todoist active task and recently completed task.

Action:
- Run `maintain_tasks`.

Expected:
- Active Todoist task becomes local `active`.
- Recently completed Todoist task becomes local `done`.
- Local done task completed outward closes Todoist task.

## Minimal Storage Verification

After each write or maintenance run, inspect `tasks.json`.

Expected task fields:

```json
{
  "id": "...",
  "projectId": "...",
  "description": "...",
  "details": null,
  "dueAt": "...",
  "status": "active",
  "externalLinks": [],
  "createdAt": "...",
  "updatedAt": "..."
}
```

Expected project fields:

```json
{
  "id": "...",
  "name": "...",
  "archived": false,
  "externalLinks": [],
  "createdAt": "...",
  "updatedAt": "..."
}
```

Expected provider links:

```json
{ "system": "todoist", "projectId": "..." }
{ "system": "todoist", "taskId": "...", "url": "..." }
{ "system": "linear", "teamId": "...", "projectId": "..." }
{ "system": "linear", "issueId": "...", "url": "..." }
```

Forbidden local storage:

- `completedAt`
- provider `updated_at` snapshots
- `syncedAt`
- nested provider `metadata`
- nested integration config

## Manual Cleanup After Real Provider Tests

- Delete disposable Todoist projects/tasks created during tests.
- Delete or archive disposable Linear issues created during tests.
- Remove temporary task store and config files.
