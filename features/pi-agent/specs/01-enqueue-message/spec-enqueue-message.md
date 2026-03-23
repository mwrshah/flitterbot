# Spec: enqueue_message Tool

Add an `enqueue_message` tool to the default Pi agent, enabling it to send messages to orchestrator sessions running on active workstreams. This is the default agent's mechanism for inter-agent communication — delegating work context, forwarding user follow-ups, or nudging an orchestrator.

## Functional Requirements

### FR1: Role-gated to default agent
The tool is registered only when `role === 'default'` in `createCustomTools()`. Orchestrators do not get this tool — they communicate back to the user via auto-surface, not by messaging other agents.

### FR2: Parameters
- `workstream_id` (string, required) — target workstream
- `message` (string, required) — content to deliver to the orchestrator

### FR3: Validate workstream exists and is open
Look up the workstream via `getWorkstreamById()` from `blackboard/queries/workstreams.ts`. Reject with a clear error if the workstream does not exist or has `status !== 'open'`.

### FR4: Find orchestrator session
Use `sessionManager.getByWorkstream(workstreamId)` to find the running orchestrator `ManagedPiSession`. If no orchestrator is running for this workstream, return an error — do not attempt to spawn one (that's `create_workstream`'s job).

### FR5: Enqueue message to orchestrator's TurnQueue
Call `orchestrator.queue.enqueue()` with a `QueueItem`:
- `id`: generated unique ID (e.g. `enq-msg-${uuid}`)
- `text`: the message content, formatted with workstream prefix via `buildWorkstreamPrompt()`
- `source`: `"web"` (internal routing — matches how `create_workstream` enqueues its initial message)
- `metadata`: include `workstream_id` and `workstream_name`
- `receivedAt`: ISO timestamp

### FR6: Persist message
Call `persistInboundMessage()` to record the message in the blackboard's message log, consistent with how all other inbound messages are persisted. Use `source: "internal"` or `"web"` and `sender: "system"` to distinguish agent-to-agent messages from human messages.

### FR7: Return confirmation
Return a success response with the workstream name and confirmation that the message was enqueued. Include queue depth if useful for the default agent's decision-making.

### FR8: Error cases
| Condition | Behavior |
|-----------|----------|
| Workstream not found | Return error: `"Workstream not found: {workstream_id}"` |
| Workstream closed | Return error: `"Workstream is closed: {workstream_name}"` |
| No orchestrator session | Return error: `"No running orchestrator for workstream: {workstream_name}"` |
| Queue stopped (orchestrator crashed) | Let the TurnQueue's own error propagate — the enqueue call will throw |

## Technical Approach

The implementation follows the existing pattern established by `create_workstream`, which already enqueues messages onto orchestrator queues. The difference is that `enqueue_message` targets an *existing* orchestrator rather than spawning a new one.

The tool is added to the `role === 'default'` block in `createCustomTools()`, alongside `create_workstream`. It captures `this.sessionManager`, `this.blackboard`, and `this.log` from the runtime closure, exactly as the existing tools do.

Message formatting should use a workstream-prefixed format (e.g. `[Workstream: "{name}" ({id})]`) consistent with how the router and context transfer format messages, so orchestrators see a uniform message shape regardless of source.

## Dependencies

- `getWorkstreamById` from `src/blackboard/queries/workstreams.ts`
- `PiSessionManager.getByWorkstream()` from `src/control-surface/pi/session-manager.ts`
- `TurnQueue.enqueue()` from `src/control-surface/queue/turn-queue.ts`
- `persistInboundMessage` from `src/blackboard/queries/messages.ts`
