# Feature: Pi Agent Tools

Custom tools given to embedded Pi agents, role-gated by agent type (default vs orchestrator). Tools are registered at session creation time and provide Pi with structured actions beyond the standard SDK tools.

## Problem

Pi agents need well-documented, role-appropriate tools. Currently tools are defined inline in `runtime.ts` (`createCustomTools()`) with no feature-level documentation. As new tools are added (e.g. inter-agent messaging), the tool surface area needs a home for specs and design rationale.

## Goals

1. Document the existing tool inventory for each Pi agent role
2. Provide a spec home for new tool additions
3. Ensure tools are role-gated — default and orchestrator agents get different capabilities matching their responsibilities

## Tool Inventory

### Shared tools (both roles)

| Tool | Description |
|------|-------------|
| `query_blackboard` | Run read-only SQL (SELECT/PRAGMA) against `blackboard.db`. Returns JSON rows. |
| `reload_resources` | Hot-reload skills, extensions, prompts, context files, and system prompt from disk. |

### Default agent only

| Tool | Description |
|------|-------------|
| `create_workstream` | Create a new workstream row, spawn a dedicated orchestrator Pi session, and optionally enqueue an initial message with context transfer. |

### Orchestrator agent only

| Tool | Description |
|------|-------------|
| `create_worktree` | Create an isolated git worktree for the workstream. Sets up a branch from `origin/main` and records paths on the workstream row. |
| `close_workstream` | Close the workstream (human-gated). Cleans up git worktree, closes the workstream row, and ends the orchestrator session. |

### Standard SDK tools (both roles)

All Pi agents also receive `read`, `bash`, and `grep` tools via `createAgentSession()` in `create-agent.ts`. These are standard Pi SDK tools, not custom tools.

## Tool Registration

Tools are created by `ControlSurfaceRuntime.createCustomTools(role, workstreamId?)` in `runtime.ts`.

- **Signature**: `createCustomTools(role: 'orchestrator' | 'default', workstreamId?: string): Array<any>`
- Shared tools are always included
- Role-specific tools are conditionally pushed based on `role === 'default'` or `role === 'orchestrator'`
- The `workstreamId` parameter is captured in closures for orchestrator tools that need it

The resulting array is passed as `customTools` to `createAutonomaAgent()` in `create-agent.ts`, which forwards it to the Pi SDK's `createAgentSession()`.

## Tool Object Shape

Each custom tool follows the Pi SDK's tool interface:

```typescript
{
  name: string;           // Machine identifier (e.g. "query_blackboard")
  label: string;          // Human-readable label
  description: string;    // Shown to the model
  parameters: {           // JSON Schema for parameters
    type: "object";
    properties: { ... };
    required: string[];
    additionalProperties: false;
  };
  execute: (toolCallId: string, params: any) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  }>;
}
```

## Dependencies

- [Control Surface](../control-surface/FEATURE.md) (Feature #3) — hosts the runtime that creates and manages Pi sessions
- [Blackboard](../blackboard/FEATURE.md) (Feature #2) — tools query and write to the shared SQLite state

## Files Touched

| File | Purpose |
|------|---------|
| `src/control-surface/runtime.ts` | `createCustomTools()` — tool definitions and execute handlers |
| `src/control-surface/pi/create-agent.ts` | Assembles standard + custom tools into `createAgentSession()` |
| `src/control-surface/pi/session-manager.ts` | Session creation; tools are passed to `createDefault()` / `createOrchestrator()` |
| `src/control-surface/queue/turn-queue.ts` | `TurnQueue.enqueue()` — used by tools that send messages to other sessions |
