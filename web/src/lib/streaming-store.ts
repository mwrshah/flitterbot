/**
 * Minimal external store for high-frequency streaming state.
 *
 * Text deltas and thinking deltas arrive at ~30Hz via WebSocket. Routing
 * these through TanStack Query would trigger cache notifications on every
 * chunk — too expensive. Instead, this store holds ephemeral streaming state
 * and exposes imperative per-session callbacks for the Lit web component to
 * consume without React re-renders.
 *
 * Lifecycle: streaming state is created on first text_delta, updated on
 * subsequent deltas, and cleared on message_end / turn_end.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { streamingPerf } from "./streaming-perf";

/* ── Types ── */

export type StreamingText = { text: string; messageId: string };
export type StreamingThinking = { text: string; messageId: string };

/* ── Per-session streaming callbacks (for imperative Lit component updates) ── */

type StreamingCallback = (
  text: string | null,
  thinking: string | null,
  isThinkingStreaming: boolean,
  messageId: string | null,
) => void;

/** Fired once at message_end with the converted AgentMessages for imperative Lit commit. */
type CommitCallback = (messages: AgentMessage[]) => void;

/* ── Store implementation ── */

const texts = new Map<string, StreamingText>();
const thinking = new Map<string, StreamingThinking>();
/** True between thinking_start and thinking_end — drives ThinkingBlock open/close. */
const thinkingActive = new Map<string, boolean>();
const streamingCallbacks = new Map<string, StreamingCallback>();
const commitCallbacks = new Map<string, CommitCallback>();

function fireCallbacks(sessionId: string) {
  const cb = streamingCallbacks.get(sessionId);
  if (!cb) return;
  const textState = texts.get(sessionId);
  const thinkingState = thinking.get(sessionId);
  const isThinkingStreaming = thinkingActive.get(sessionId) ?? false;
  const messageId = textState?.messageId ?? thinkingState?.messageId ?? null;
  const hasContent = textState != null || thinkingState != null;
  const effectiveMessageId = hasContent ? messageId : null;
  cb(textState?.text ?? null, thinkingState?.text ?? null, isThinkingStreaming, effectiveMessageId);
}

/* ── Public API (called by ws-query-bridge) ── */

export const streamingStore = {
  /* ── Text streaming ── */

  appendTextDelta(sessionId: string, messageId: string, delta: string) {
    const deltaToken = streamingPerf.beginDeltaToCallback();
    const existing = texts.get(sessionId);
    if (existing) {
      existing.text += delta;
      existing.messageId = messageId;
    } else {
      texts.set(sessionId, { text: delta, messageId });
    }
    fireCallbacks(sessionId);
    streamingPerf.endDeltaToCallback(deltaToken);
  },

  clearText(sessionId: string) {
    texts.delete(sessionId);
    fireCallbacks(sessionId);
  },

  /* ── Thinking streaming ── */

  appendThinkingDelta(sessionId: string, messageId: string, delta: string) {
    const deltaToken = streamingPerf.beginDeltaToCallback();
    const existing = thinking.get(sessionId);
    if (existing) {
      existing.text += delta;
      existing.messageId = messageId;
    } else {
      thinking.set(sessionId, { text: delta, messageId });
    }
    fireCallbacks(sessionId);
    streamingPerf.endDeltaToCallback(deltaToken);
  },

  /* ── Thinking active state (between thinking_start and thinking_end) ── */

  /** Signal that thinking has started/ended. Pre-initialises the thinking store
   *  with the messageId so callbacks fire immediately even before the first delta. */
  setThinkingStreaming(sessionId: string, active: boolean, messageId?: string) {
    thinkingActive.set(sessionId, active);
    if (active && messageId && !thinking.get(sessionId)) {
      thinking.set(sessionId, { text: "", messageId });
    }
    fireCallbacks(sessionId);
  },

  /* ── Clear all streaming for a session (turn_end / agent_end) ── */

  /** Idempotent: only fires callback if there was actually streaming state to clear. */
  clearSession(sessionId: string) {
    const hadState =
      texts.has(sessionId) || thinking.has(sessionId) || thinkingActive.has(sessionId);

    if (!hadState) {
      console.log(
        "[debug][streaming-store] clearSession SKIPPED (already clear) for session=%s",
        sessionId,
      );
      return;
    }

    console.log("[debug][streaming-store] clearSession for session=%s", sessionId);
    texts.delete(sessionId);
    thinking.delete(sessionId);
    thinkingActive.delete(sessionId);
    fireCallbacks(sessionId);
  },

  /* ── Imperative callbacks for Lit component integration ── */

  onStreamingDelta(sessionId: string, callback: StreamingCallback) {
    if (streamingCallbacks.has(sessionId)) {
      console.warn(
        "[streaming-store] onStreamingDelta: overwriting existing callback for session=%s — unexpected double-mount?",
        sessionId,
      );
    }
    streamingCallbacks.set(sessionId, callback);
  },

  offStreamingDelta(sessionId: string) {
    streamingCallbacks.delete(sessionId);
  },

  /* ── Imperative commit callbacks (message_end → Lit component) ── */

  onCommit(sessionId: string, callback: CommitCallback) {
    commitCallbacks.set(sessionId, callback);
  },

  offCommit(sessionId: string) {
    commitCallbacks.delete(sessionId);
  },

  /** Fire the commit callback with already-converted AgentMessages.
   *  Called from ws-query-bridge after message_end setQueryData. */
  commitMessage(sessionId: string, agentMessages: AgentMessage[]) {
    const cb = commitCallbacks.get(sessionId);
    if (cb) cb(agentMessages);
  },
};
