/**
 * Minimal external store for high-frequency streaming state.
 *
 * Text deltas, thinking deltas, and tool-call deltas arrive at ~30Hz via
 * StreamChunker. Routing these through TanStack Query would trigger cache
 * notifications on every chunk — too expensive. Instead, this store holds
 * ephemeral streaming state and exposes imperative per-session callbacks
 * for the Lit web component to consume without React re-renders.
 *
 * Lifecycle: streaming state is created on first text_delta, updated on
 * subsequent deltas, and cleared on message_end / turn_end.
 */

/* ── Types ── */

export type StreamingText = { text: string; messageId: string };
export type StreamingThinking = { text: string; messageId: string };
export type PendingToolCall = { toolUseId: string; toolName: string | undefined };

/* ── Per-session streaming callbacks (for imperative Lit component updates) ── */

type StreamingCallback = (text: string | null, messageId: string | null) => void;

/* ── Store implementation ── */

const texts = new Map<string, StreamingText>();
const thinking = new Map<string, StreamingThinking>();
/** Tool calls seen via toolcall_start, held until message_end commits them after the message. */
const pendingTools = new Map<string, PendingToolCall[]>();
const streamingCallbacks = new Map<string, StreamingCallback>();

function fireCallbacks(sessionId: string) {
  const state = texts.get(sessionId);
  const cb = streamingCallbacks.get(sessionId);
  if (cb) cb(state?.text ?? null, state?.messageId ?? null);
}

/* ── Public API (called by ws-query-bridge) ── */

export const streamingStore = {
  /* ── Text streaming ── */

  /** Read current streaming text without side effects. Used by agent_end flush. */
  getUncommittedText(sessionId: string): StreamingText | undefined {
    return texts.get(sessionId);
  },

  appendTextDelta(sessionId: string, messageId: string, delta: string) {
    const existing = texts.get(sessionId);
    if (existing) {
      existing.text += delta;
      existing.messageId = messageId;
    } else {
      texts.set(sessionId, { text: delta, messageId });
    }
    fireCallbacks(sessionId);
  },

  clearText(sessionId: string) {
    texts.delete(sessionId);
    fireCallbacks(sessionId);
  },

  /* ── Thinking streaming ── */

  appendThinkingDelta(sessionId: string, messageId: string, delta: string) {
    const existing = thinking.get(sessionId);
    if (existing) {
      existing.text += delta;
      existing.messageId = messageId;
    } else {
      thinking.set(sessionId, { text: delta, messageId });
    }
    // Do NOT call fireCallbacks here — thinking deltas must not trigger the text
    // streaming callback. Doing so fires cb(null, null) when no text is in flight,
    // which calls clearStreaming() and queues rAF hide callbacks. Those callbacks
    // then fire and hide the streaming element mid-stream when text later starts.
  },

  clearThinking(sessionId: string) {
    thinking.delete(sessionId);
  },

  /* ── Pending tool calls (buffered between toolcall_start and message_end) ── */

  addPendingToolCall(sessionId: string, call: PendingToolCall) {
    const existing = pendingTools.get(sessionId) ?? [];
    existing.push(call);
    pendingTools.set(sessionId, existing);
  },

  /** Returns and clears all pending tool calls for the session. */
  flushPendingToolCalls(sessionId: string): PendingToolCall[] {
    const calls = pendingTools.get(sessionId) ?? [];
    pendingTools.delete(sessionId);
    return calls;
  },

  /* ── Clear all streaming for a session (turn_end / agent_end) ── */

  clearSession(sessionId: string) {
    texts.delete(sessionId);
    thinking.delete(sessionId);
    pendingTools.delete(sessionId);
    fireCallbacks(sessionId);
  },

  /* ── Imperative callbacks for Lit component integration ── */

  onStreamingDelta(sessionId: string, callback: StreamingCallback) {
    streamingCallbacks.set(sessionId, callback);
  },

  offStreamingDelta(sessionId: string) {
    streamingCallbacks.delete(sessionId);
  },
};
