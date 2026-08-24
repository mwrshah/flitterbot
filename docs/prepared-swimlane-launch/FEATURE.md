# Prepared Swimlane Launch

## Problem

The default agent needs to propose one or more swimlanes for review without creating them immediately.

## Architecture

`prep_launch` is a structured intent marker. Its validated arguments persist in the Pi timeline. After successful tool completion, chat reads `item.args.launches` and renders one editable JSON card per launch. Card edits stay in local component state.

Prepared cwd values use an `@/absolute/path` editor form. The card's shared textarea-completion controller uses a lightweight `"cwd": "` marker check to switch `@` to absolute, directory-only completion. Elsewhere in the free-form textarea, `@` completes paths relative to the proposed cwd and `/` inserts `/skill:` references. Built-in session commands are excluded because the initial message enters the new stream as agent context rather than direct command input. The marker and cwd lookups run only when a completion trigger is typed or the selection enters an existing token, so ordinary typing does not scan or parse the document.

Each card adds the trusted source Pi session ID and uses the existing `POST /api/streams` endpoint. The route trims the final cwd, removes its leading `@`, validates the normalized absolute path, and passes only the prefix-free cwd into the runtime. Ownership comes from persisted Pi-session and stream rows, so the source session does not need to be active.

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
            → normalize @/cwd and validate edited payload
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
       Completion: useTextareaCompletions(prepared launch resolver)
       ├─ <textarea>
       ├─ <TextareaCompletionPickers preferredPlacement="bottom">
       └─ launch button → apiClient.createSwimlane()
```

## Files

- `src/contracts/control-surface-api.ts` — strict scratch-or-prepared request contract.
- `src/runtime.ts` — marker tool with the `@/cwd` contract, ownership lookup, spawn, and prompt enqueue.
- `src/routes/create-swimlane.ts` — final edited-payload cwd normalization and validation.
- `src/routes/browser-directory-completions.ts` — optional explicit base cwd for prepared-message relative paths.
- `web/src/lib/api.ts` and `web/src/lib/types.ts` — shared request and useful server errors.
- `web/src/lib/prepared-launch-completions.ts` — trigger-time JSON property detection and prepared cwd reading.
- `web/src/hooks/use-textarea-completions.tsx` — shared textarea completion state, queries, keyboard handling, and insertion.
- `web/src/components/common/floating-command-picker.tsx` — portal-backed top/bottom picker positioning.
- `web/src/components/chat-tool-message.tsx` — argument-backed editable cards and prepared completion integration.
