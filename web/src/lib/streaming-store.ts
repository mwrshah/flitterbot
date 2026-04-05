/**
 * Unified imperative store for all ephemeral per-session state.
 *
 * Holds two categories of state outside React:
 *
 * 1. **Streaming deltas** — text, thinking, and toolCall chunks arrive at
 *    ~30Hz via WebSocket. Lit reads them imperatively via callbacks.
 *
 * 2. **Active tool execution progress** — tool_execution_start/update/end
 *    events live here as ephemeral state keyed by toolUseId. Lit tool cards
 *    are updated imperatively, avoiding React re-renders.
 *
 * Both are cleared on message_end / turn_end / agent_end via `clearSession`.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { streamingPerf } from "./streaming-perf";

/* ── Types ── */

export type StreamingText = { text: string; messageId: string };
export type StreamingThinking = { text: string; messageId: string };
export type StreamingToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type ActiveToolState = {
  toolUseId: string;
  pending: boolean;
  partialResult?: unknown;
  isError?: boolean;
};

export type ActiveToolStoreEvent =
  | { type: "upsert"; state: ActiveToolState }
  | { type: "clear_all" };

/* ── Per-session streaming callbacks (for imperative Lit component updates) ── */

type StreamingCallback = (
  text: string | null,
  thinking: string | null,
  isThinkingStreaming: boolean,
  messageId: string | null,
  toolCalls: StreamingToolCall[],
) => void;

/** Fired once at message_end with the converted AgentMessages for imperative Lit commit. */
type CommitCallback = (messages: AgentMessage[]) => void;
/** Fired once at canonical tool_result with the converted toolResult AgentMessage. */
type ToolResultCommitCallback = (message: AgentMessage) => void;
/** Fired on tool_execution_start/update/end or session clear. */
type ActiveToolCallback = (event: ActiveToolStoreEvent) => void;

/* ── Store implementation ── */

const texts = new Map<string, StreamingText>();
const thinking = new Map<string, StreamingThinking>();
/** True between thinking_start and thinking_end — drives ThinkingBlock open/close. */
const thinkingActive = new Map<string, boolean>();
/** Accumulated toolCalls during streaming (from toolcall_start events). */
const toolCalls = new Map<string, StreamingToolCall[]>();
const streamingCallbacks = new Map<string, StreamingCallback>();
const commitCallbacks = new Map<string, CommitCallback>();
const toolResultCommitCallbacks = new Map<string, ToolResultCommitCallback>();

/* ── Active tool execution state ── */

const activeToolsBySession = new Map<string, Map<string, ActiveToolState>>();
const activeToolCallbacks = new Map<string, ActiveToolCallback>();

function getSessionTools(sessionId: string): Map<string, ActiveToolState> {
  let tools = activeToolsBySession.get(sessionId);
  if (!tools) {
    tools = new Map<string, ActiveToolState>();
    activeToolsBySession.set(sessionId, tools);
  }
  return tools;
}

function emitActiveToolEvent(sessionId: string, event: ActiveToolStoreEvent): void {
  const callback = activeToolCallbacks.get(sessionId);
  if (callback) callback(event);
}

function fireCallbacks(sessionId: string) {
  const cb = streamingCallbacks.get(sessionId);
  if (!cb) return;
  const textState = texts.get(sessionId);
  const thinkingState = thinking.get(sessionId);
  const isThinkingStreaming = thinkingActive.get(sessionId) ?? false;
  const sessionToolCalls = toolCalls.get(sessionId) ?? [];
  const messageId = textState?.messageId ?? thinkingState?.messageId ?? null;
  const hasContent = textState != null || thinkingState != null || sessionToolCalls.length > 0;
  const effectiveMessageId = hasContent ? messageId : null;
  cb(textState?.text ?? null, thinkingState?.text ?? null, isThinkingStreaming, effectiveMessageId, sessionToolCalls);
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

  /* ── Tool call streaming (from toolcall_start events) ── */

  appendToolCall(sessionId: string, toolCall: StreamingToolCall) {
    const existing = toolCalls.get(sessionId);
    if (existing) {
      existing.push(toolCall);
    } else {
      toolCalls.set(sessionId, [toolCall]);
    }
    fireCallbacks(sessionId);
  },

  /* ── Clear all streaming for a session (turn_end / agent_end) ── */

  /** Idempotent: clears all streaming AND active tool state for the session. */
  clearSession(sessionId: string) {
    const hadStreaming =
      texts.has(sessionId) || thinking.has(sessionId) || thinkingActive.has(sessionId) || toolCalls.has(sessionId);
    const hadActiveTools = activeToolsBySession.has(sessionId);

    if (!hadStreaming && !hadActiveTools) {
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
    toolCalls.delete(sessionId);
    if (hadStreaming) fireCallbacks(sessionId);

    if (hadActiveTools) {
      activeToolsBySession.delete(sessionId);
      emitActiveToolEvent(sessionId, { type: "clear_all" });
    }
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
    console.log(
      "[debug][streaming-store] commitMessage: session=%s messages=%d hasCallback=%s",
      sessionId,
      agentMessages.length,
      String(!!cb),
    );
    if (cb) cb(agentMessages);
  },

  onToolResultCommit(sessionId: string, callback: ToolResultCommitCallback) {
    toolResultCommitCallbacks.set(sessionId, callback);
  },

  offToolResultCommit(sessionId: string) {
    toolResultCommitCallbacks.delete(sessionId);
  },

  commitToolResult(sessionId: string, agentMessage: AgentMessage) {
    const cb = toolResultCommitCallbacks.get(sessionId);
    console.log(
      "[debug][streaming-store] commitToolResult: session=%s hasCallback=%s",
      sessionId,
      String(!!cb),
    );
    if (cb) cb(agentMessage);
  },

  /* ── Active tool execution progress (tool_execution_start/update/end) ── */

  getActiveToolSnapshot(sessionId: string): ActiveToolState[] {
    const tools = activeToolsBySession.get(sessionId);
    return tools ? Array.from(tools.values()).map((state) => ({ ...state })) : [];
  },

  upsertTool(
    sessionId: string,
    next: Pick<ActiveToolState, "toolUseId"> &
      Partial<Omit<ActiveToolState, "toolUseId">> & { pending?: boolean },
  ): void {
    const tools = getSessionTools(sessionId);
    const prev = tools.get(next.toolUseId);
    const merged: ActiveToolState = {
      toolUseId: next.toolUseId,
      pending: next.pending ?? prev?.pending ?? true,
      partialResult: next.partialResult !== undefined ? next.partialResult : prev?.partialResult,
      isError: next.isError ?? prev?.isError,
    };
    tools.set(next.toolUseId, merged);
    emitActiveToolEvent(sessionId, { type: "upsert", state: { ...merged } });
  },

  /**
   * Remove a tool from the backing store without emitting a UI clear event.
   *
   * The canonical tool_result render path takes over immediately after this
   * point, so silent removal avoids a transient clear/flicker while also
   * preventing stale hydration on remount.
   */
  dropTool(sessionId: string, toolUseId: string): void {
    const tools = activeToolsBySession.get(sessionId);
    if (!tools) return;
    tools.delete(toolUseId);
    if (tools.size === 0) {
      activeToolsBySession.delete(sessionId);
    }
  },

  onActiveToolUpdate(sessionId: string, callback: ActiveToolCallback): void {
    activeToolCallbacks.set(sessionId, callback);
  },

  offActiveToolUpdate(sessionId: string): void {
    activeToolCallbacks.delete(sessionId);
  },
};
