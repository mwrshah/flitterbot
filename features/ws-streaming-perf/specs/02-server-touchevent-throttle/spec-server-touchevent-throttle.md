# Spec: Server-Side touchPiEvent Throttle

Throttle the synchronous SQLite write in touchPiEvent during text_delta streaming to reduce unnecessary disk I/O on the hot path.

## Functional Requirements

### FR1: Throttle touchPiEvent for text_delta events
In src/pi/subscribe.ts, the touchPiEvent() call at line ~92 fires on every event including every text_delta. During streaming, the pi_session status doesn't meaningfully change between consecutive deltas. Throttle this call so it fires at most once per second during active streaming. On non-delta events (tool_execution, message_end, turn_end), always fire immediately.

### FR2: Implementation approach
Use a simple timestamp check: store the last touch time per session. On text_delta, skip if <1000ms since last touch. On any other event type, always touch and reset the timer.

## Constraints
- Must not affect the accuracy of last_event_at for non-streaming events
- Must still fire on the first text_delta of a new stream
- No new dependencies
