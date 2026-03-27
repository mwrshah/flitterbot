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
export type StreamingToolCall = { contentIndex: number; toolName: string; argsJson: string };

/* ── Per-session streaming callbacks (for imperative Lit component updates) ── */

type StreamingCallback = (text: string | null, messageId: string | null) => void;

/* ── Store implementation ── */

const texts = new Map<string, StreamingText>();
const thinking = new Map<string, StreamingThinking>();
const toolCalls = new Map<string, StreamingToolCall[]>();
const streamingCallbacks = new Map<string, StreamingCallback>();

function fireCallbacks(sessionId: string) {
  const state = texts.get(sessionId);
  const cb = streamingCallbacks.get(sessionId);
  if (cb) cb(state?.text ?? null, state?.messageId ?? null);
}

/* ── Public API (called by ws-query-bridge) ── */

export const streamingStore = {
  /* ── Text streaming ── */

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
    // Trigger text callbacks too so UI re-renders with thinking content
    fireCallbacks(sessionId);
  },

  clearThinking(sessionId: string) {
    thinking.delete(sessionId);
  },

  /* ── Tool call streaming ──
   * These methods receive real data from toolcall_start/toolcall_delta WS events.
   * No UI component reads tool call state yet — ready for future UI consumption
   * (e.g. showing in-progress tool call arguments in the chat panel). */

  startToolCall(sessionId: string, contentIndex: number, toolName: string) {
    const calls = toolCalls.get(sessionId) ?? [];
    calls.push({ contentIndex, toolName, argsJson: "" });
    toolCalls.set(sessionId, calls);
  },

  appendToolCallDelta(sessionId: string, contentIndex: number, delta: string) {
    const calls = toolCalls.get(sessionId);
    if (!calls) return;
    const call = calls.find((c) => c.contentIndex === contentIndex);
    if (call) call.argsJson += delta;
  },

  clearToolCalls(sessionId: string) {
    toolCalls.delete(sessionId);
  },

  /* ── Clear all streaming for a session (turn_end / message_end) ── */

  clearSession(sessionId: string) {
    texts.delete(sessionId);
    thinking.delete(sessionId);
    toolCalls.delete(sessionId);
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
