# Prepared Swimlane Launch

## Problem

`create_swimlane` starts at most one stream for a user turn and always passes through the user message. When the user explicitly asks to prep one or more tasks, the default agent needs to emit launch options without starting work.

## Architecture

`prep_launch` accepts one batch of canonical launch arguments and returns only a text acknowledgement. The frontend custom-renders the persisted tool-call arguments as editable cards.

```ts
type SwimlaneLaunchArgs = {
  suggestedName: string
  cwd: string
  initialMessage: string
  additionalContext?: string
}

type PrepLaunchArgs = { launches: SwimlaneLaunchArgs[] }
```

Each card owns local edit, request, error, and success state. Remounting the virtual row or refreshing restores the original tool-call arguments. Edits never mutate Pi JSONL and have no replay or persistence layer.

Each arrow sends one edited `SwimlaneLaunchArgs` to `POST /api/pi-sessions/:id/prepared-swimlanes`. The source Pi session supplies stream ownership. The route calls the existing programmatic stream creation operation, which spawns the orchestrator and enqueues the targeted initial prompt. The scratch creation endpoint remains `POST /api/streams { name?, cwd? }`.

## Pseudocode Contracts and Call Graph

```text
default agent
  -> prep_launch({ launches })
    -> Pi tool-call timeline
      -> PreparedLaunchBatch
        -> PreparedLaunchChip × launch count
          -> POST /api/pi-sessions/:sourceId/prepared-swimlanes
            -> createSwimlaneProgrammatic({
                 name, cwd, initialMessage,
                 additionalContext, sourcePiSessionId
               })
              -> derive streamUser
              -> spawnStreamWithSession
              -> buildStreamPrompt
              -> orchestrator TurnQueue
```

Direct creation remains separate:

```text
create_swimlane once per user turn
  -> relevant user-message classification
  -> spawnStreamWithSession
  -> orchestrator TurnQueue
```

## Component Tree

```text
<ChatMessageRow>
  -> <ToolMessage name="prep_launch">
    -> <PreparedLaunchBatch>
      -> <PreparedLaunchChip> × launch count
         State: edited JSON, mutation result, inline error
         Event: submit this card with source Pi session ID
```

## Files

- `src/contracts/control-surface-api.ts` — define `SwimlaneLaunchArgs`.
- `src/prompts/default-agent.ts` — select one batch-shaped `prep_launch` call when requested.
- `src/runtime.ts` — register `prep_launch`, keep direct creation single, and launch prepared prompts with source ownership.
- `src/routes/launch-prepared-swimlane.ts` — validate and launch one edited card.
- `src/server.ts` — dispatch the prepared-launch endpoint.
- `web/src/lib/api.ts` — call the endpoint and surface server errors.
- `web/src/components/chat-tool-message.tsx` — render and submit editable cards.
- `src/prepared-swimlane-launch.test.ts` — cover the prepared-launch request contract.
