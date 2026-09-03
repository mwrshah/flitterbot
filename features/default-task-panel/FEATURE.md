# Default Task Panel

## Problem

The default Flitterbot swimlane cannot have downstream sessions, so its Alt+I info panel uses that space to show actionable local tasks instead.

## Goals

- Show active tasks whose due time has arrived, grouped by active project.
- Keep the compact view limited to project names and task descriptions.
- Reveal only a task's longer `details` text when that task is opened.
- Preserve the downstream sessions and worktree panel for every non-default swimlane.
- Reload the due-task query when Info is activated while already selected.
- Keep task-store parsing and grouping off the client render path.

## Architecture

The control-surface backend reads the local `tasks.json` store and returns a small display contract. It filters out completed tasks, future tasks, archived projects, and projects with no due tasks before sending data to the web client.

The route identifies the default Pi session from status data and tells `DownstreamSessionsPanel` to mount `DueTasksPanel` in its info surface only for that session. Other sessions keep the existing active-session content.

## Pseudocode Contracts and Call Graph

```ts
interface DueTaskItem {
  id: string
  description: string
  details: string | null
}

interface DueTaskProject {
  id: string
  name: string
  tasks: DueTaskItem[]
}

interface DueTasksResponse {
  projects: DueTaskProject[]
}

readDueTasks(storePath, now): DueTasksResponse
  parse tasks.json
  select active, due tasks belonging to active projects
  preserve store ordering within alphabetically sorted projects
```

Production:

```text
GET /api/tasks/due
  → handleBrowserDueTasksRoute
    → readDueTasks
      → ~/.flitterbot/data/tasks/tasks.json

PiSessionRoute
  → default session: DownstreamSessionsPanel(showDueTasks)
    → DueTasksPanel
      → dueTasksQueryOptions
      → fetchDueTasks server function
        → GET /api/tasks/due
  → other session: DownstreamSessionsPanel
```

## Component Tree

```text
<PiSessionRoute>
└── <Panel id="downstream">
    ├── default session: <DueTasksPanel>
    │   │ Server state: due task project query
    │   └── native <details> per project
    │       └── native <details> per task with details
    │           ├── compact summary: task.description
    │           └── expanded body: task.details
    └── non-default session: <DownstreamSessionsPanel>
```

Native disclosure elements own expansion state. There is no synchronized component state, client-side grouping, or custom accordion dependency. Clicking Info again or pressing its shortcut while selected refetches the active due-task query, matching the diff panel's reload interaction.

## Plan

1. Add the due-task display contract and read-only backend endpoint.
2. Add the web server function and React Query options.
3. Add a minimal project/task disclosure panel.
4. Select that panel only for the default session route.
5. Run static and type checks.

## Files

- `features/default-task-panel/FEATURE.md` — create: canonical behavior and architecture.
- `src/contracts/control-surface-api.ts` — modify: shared due-task response contract.
- `src/routes/browser-due-tasks.ts` — create: task-store parsing, filtering, grouping, and endpoint handler.
- `src/server.ts` — modify: register the due-task endpoint.
- `src/routes/index.ts` — modify: export the endpoint handler.
- `web/src/server/tasks.ts` — create: server-side backend request.
- `web/src/lib/queries.ts` — modify: expose due-task query options.
- `web/src/lib/types.ts` — modify: export the shared response type.
- `web/src/components/due-tasks-panel.tsx` — create: minimal native disclosure UI.
- `web/src/routes/streams.$piSessionId.tsx` — modify: render the task panel only for the default session.
