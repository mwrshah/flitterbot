/**
 * Minimal external store for high-frequency streaming state.
 *
 * Text deltas, thinking deltas, and tool-call deltas arrive at ~30Hz via
 * StreamChunker. Routing these through TanStack Query would trigger cache
 * notifications on every chunk — too expensive. Instead, this store holds
 * ephemeral streaming state and exposes it via useSyncExternalStore for
 * tearing-safe reads without React re-renders on every delta.
 *
 * Lifecycle: streaming state is created on first text_delta, updated on
 * subsequent deltas, and cleared on message_end / turn_end.
 */


/* ── Types ── */

export type StreamingText = { text: string; messageId: string };
export type StreamingThinking = { text: string; messageId: string };
export type StreamingToolCall = { contentIndex: number; toolName: string; argsJson: string };

type StreamingSnapshot = {
  /** Active text stream per session */
  texts: ReadonlyMap<string, StreamingText>;
  /** Active thinking stream per session */
  thinking: ReadonlyMap<string, StreamingThinking>;
  /** Active tool calls per session */
  toolCalls: ReadonlyMap<string, readonly StreamingToolCall[]>;
};

/* ── Per-session streaming callbacks (for imperative Lit component updates) ── */

type StreamingCallback = (text: string | null, messageId: string | null) => void;
type GlobalStreamingCallback = (sessionId: string, text: string | null, messageId: string | null) => void;

/* ── Store implementation ── */

const texts = new Map<string, StreamingText>();
const thinking = new Map<string, StreamingThinking>();
const toolCalls = new Map<string, StreamingToolCall[]>();
const listeners = new Set<() => void>();
const streamingCallbacks = new Map<string, StreamingCallback>();
const globalStreamingCallbacks = new Set<GlobalStreamingCallback>();

let snapshot: StreamingSnapshot = {
  texts: new Map(),
  thinking: new Map(),
  toolCalls: new Map(),
};

function notify() {
  snapshot = {
    texts: new Map(texts),
    thinking: new Map(thinking),
    toolCalls: new Map(toolCalls),
  };
  for (const fn of listeners) fn();
}

function fireCallbacks(sessionId: string) {
  const state = texts.get(sessionId);
  const cb = streamingCallbacks.get(sessionId);
  if (cb) cb(state?.text ?? null, state?.messageId ?? null);
  for (const gcb of globalStreamingCallbacks) {
    gcb(sessionId, state?.text ?? null, state?.messageId ?? null);
  }
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
    // No notify() — we don't trigger React re-renders for every delta.
    // The Lit component is updated imperatively via callbacks.
  },

  clearText(sessionId: string) {
    texts.delete(sessionId);
    fireCallbacks(sessionId);
    notify();
  },

  getText(sessionId: string): StreamingText | null {
    return texts.get(sessionId) ?? null;
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

  /* ── Tool call streaming ── */

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
    notify();
  },

  /* ── Imperative callbacks for Lit component integration ── */

  onStreamingDelta(sessionId: string, callback: StreamingCallback) {
    streamingCallbacks.set(sessionId, callback);
  },

  offStreamingDelta(sessionId: string) {
    streamingCallbacks.delete(sessionId);
  },

  onAnyStreamingDelta(callback: GlobalStreamingCallback) {
    globalStreamingCallbacks.add(callback);
  },

  offAnyStreamingDelta(callback: GlobalStreamingCallback) {
    globalStreamingCallbacks.delete(callback);
  },

  /* ── useSyncExternalStore integration ── */

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },

  getSnapshot(): StreamingSnapshot {
    return snapshot;
  },
};

