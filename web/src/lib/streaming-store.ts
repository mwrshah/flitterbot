import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { streamingUiDebug } from "./debug-log";
import { streamingPerf } from "./streaming-perf";

type StreamingText = { text: string; messageId: string };
type StreamingThinking = { text: string; messageId: string };

type StreamingCallback = (
  text: string | null,
  thinking: string | null,
  isThinkingStreaming: boolean,
  messageId: string | null,
) => void;

type CommitCallback = (messages: AgentMessage[]) => void;
type ToolResultCommitCallback = (message: AgentMessage) => void;

const texts = new Map<string, StreamingText>();
const thinking = new Map<string, StreamingThinking>();
const thinkingActive = new Map<string, boolean>();
const streamingCallbacks = new Map<string, StreamingCallback>();
const commitCallbacks = new Map<string, CommitCallback>();
const toolResultCommitCallbacks = new Map<string, ToolResultCommitCallback>();

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

export const streamingStore = {
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

  setThinkingStreaming(sessionId: string, active: boolean, messageId?: string) {
    thinkingActive.set(sessionId, active);
    if (active && messageId && !thinking.get(sessionId)) {
      thinking.set(sessionId, { text: "", messageId });
    }
    fireCallbacks(sessionId);
  },

  clearSession(sessionId: string) {
    const hadState =
      texts.has(sessionId) || thinking.has(sessionId) || thinkingActive.has(sessionId);

    if (!hadState) {
      streamingUiDebug(
        "[debug][streaming-store] clearSession SKIPPED (already clear) for session=%s",
        sessionId,
      );
      return;
    }

    streamingUiDebug("[debug][streaming-store] clearSession for session=%s", sessionId);
    texts.delete(sessionId);
    thinking.delete(sessionId);
    thinkingActive.delete(sessionId);
    fireCallbacks(sessionId);
  },

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

  onCommit(sessionId: string, callback: CommitCallback) {
    commitCallbacks.set(sessionId, callback);
  },

  offCommit(sessionId: string) {
    commitCallbacks.delete(sessionId);
  },

  commitMessage(sessionId: string, agentMessages: AgentMessage[]) {
    const cb = commitCallbacks.get(sessionId);
    streamingUiDebug(
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
    streamingUiDebug(
      "[debug][streaming-store] commitToolResult: session=%s hasCallback=%s",
      sessionId,
      String(!!cb),
    );
    if (cb) cb(agentMessage);
  },
};
