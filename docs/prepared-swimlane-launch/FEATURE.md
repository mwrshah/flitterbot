# Prepared Swimlane Launch

## Problem

The default agent needs to propose one or more swimlanes for review without creating them immediately.

## Architecture

`prep_launch` is a structured intent marker. Its validated arguments persist in the Pi timeline. After successful tool completion, chat reads `item.args.launches` and renders one editable JSON card per launch. Card edits stay in local component state.

Each card adds the trusted source Pi session ID and uses the existing `POST /api/streams` endpoint. The route validates and normalizes the final edited payload. Ownership comes from persisted Pi-session and stream rows, so the source session does not need to be active.

```ts
type SwimlaneLaunchArgs = {
  name: string
  cwd: string
  message: string
}
```

## Pseudocode Contracts and Call Graph

```text
default agent
  → prep_launch({ launches })
    → persisted tool arguments
      → ToolMessage
        → PreparedLaunchCard × launch count
          → POST /api/streams
            → validate edited payload
            → createSwimlaneProgrammatic()
              → persisted source ownership lookup
              → spawnStreamWithSession()
              → enqueue initial orchestrator prompt
```

A successful spawn returns HTTP success even if prompt enqueue fails. The response includes a warning, and the launched card remains disabled to prevent a duplicate retry.

## Component Tree

```text
<ToolMessage name="prep_launch">
  └─ <PreparedLaunchCard> × launch count
       State: edited JSON, request result, inline error
       Event: apiClient.createSwimlane()
```

## Files

- `src/contracts/control-surface-api.ts` — strict scratch-or-prepared request contract.
- `src/runtime.ts` — marker tool, ownership lookup, spawn, and prompt enqueue.
- `src/routes/create-swimlane.ts` — final edited-payload validation.
- `web/src/lib/api.ts` and `web/src/lib/types.ts` — shared request and useful server errors.
- `web/src/components/chat-tool-message.tsx` — argument-backed editable cards.
