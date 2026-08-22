import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { touchPiEvent } from "../blackboard/pi-sessions.ts";
import type {
  ChatTimelineMessage,
  ChatTimelineMessageBlock,
  ChatTimelineTool,
  JsonValue,
} from "../contracts/index.ts";
import type { WebSocketHub } from "../ws/hub.ts";
import { ensureConversationMessageId, findConversationEntry } from "./conversation-identity.ts";
import { flitterbotHookToTimelineMessage, piMessageToTimelineItems } from "./history.ts";
import type { PiSessionState } from "./pi-session-state.ts";
import type { ToolDisplayContextCache } from "./tool-display.ts";

function hasPartialContent(partial: unknown): boolean {
  if (partial == null) return false;
  if (typeof partial !== "object") return true;
  const r = partial as Record<string, unknown>;
  if ("content" in r) return Array.isArray(r.content) && r.content.length > 0;
  return Object.keys(r).length > 0;
}

function broadcastSurfaced(
  wsHub: WebSocketHub,
  piSessionId: string,
  message: ChatTimelineMessage,
): void {
  wsHub.broadcast({
    type: "stream_surfaced",
    piSessionId,
    message,
    streamId: message.streamId,
    streamName: message.streamName,
  });
}

function reportMissingPersistedMessage(
  wsHub: WebSocketHub,
  piSessionId: string,
  messageId: string | undefined,
): void {
  const detail = messageId ? ` for Flitterbot message ${messageId}` : " without a Flitterbot ID";
  const message = `Pi persisted-message lookup failed${detail}`;
  console.error("%s (piSessionId=%s)", message, piSessionId);
  wsHub.broadcast({ type: "error", message, piSessionId });
}

function timelineBlock(content: AssistantMessage["content"][number]): ChatTimelineMessageBlock {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "thinking":
      return { type: "thinking", thinking: content.thinking };
    case "toolCall":
      return { type: "tool", toolUseId: content.id };
  }
}

function timelineTool(
  toolCall: ToolCall,
  createdAt: string,
  displayArgs?: JsonValue,
): ChatTimelineTool | undefined {
  if (!toolCall.id.trim() || !toolCall.name.trim()) return undefined;
  return {
    id: `tool-${toolCall.id}-start`,
    kind: "tool",
    tool: toolCall.name,
    phase: "start",
    toolUseId: toolCall.id,
    args: structuredClone(toolCall.arguments) as JsonValue,
    ...(displayArgs ? { displayArgs } : {}),
    createdAt,
  };
}

type BroadcastRole = "user" | "assistant";
type AnyMessageRole = BroadcastRole | "toolResult";
type AgentOutcomeMessage = { role: string; stopReason?: string };

export function selectCompletedAssistantMessage(
  messages: readonly AgentOutcomeMessage[],
  pending: ChatTimelineMessage | null,
): ChatTimelineMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return message.stopReason !== "error" && message.stopReason !== "aborted" ? pending : null;
  }
  return null;
}

function extractMessageRole(message: unknown): BroadcastRole | undefined {
  const role = extractAnyMessageRole(message);
  return role === "user" || role === "assistant" ? role : undefined;
}

function extractAnyMessageRole(message: unknown): AnyMessageRole | undefined {
  if (!message || typeof message !== "object") return undefined;

  const role = (message as Record<string, unknown>).role;
  if (role === "user" || role === "assistant" || role === "toolResult") {
    return role;
  }

  return undefined;
}

function extractTimestamp(message: unknown, fallback: string): string {
  if (!message || typeof message !== "object") return fallback;

  const timestamp = (message as Record<string, unknown>).timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  if (typeof timestamp === "string" && timestamp.trim()) {
    return timestamp;
  }

  return fallback;
}

type PiSessionLifecycleCallbacks = {
  onAgentEnd?: (lastAssistantMessage: ChatTimelineMessage | null) => void;
  onAgentSettled?: () => void;
};

export function subscribeToPiSession(
  session: AgentSession,
  state: PiSessionState,
  blackboard: BlackboardDatabase,
  wsHub: WebSocketHub,
  toolDisplayCache: ToolDisplayContextCache,
  sessionStreamId?: string | null,
  sessionStreamName?: string | null,
  lifecycle: PiSessionLifecycleCallbacks = {},
): () => void {
  let currentStreamingMessageId: string | null = null;
  let currentStreamingMessage: AssistantMessage | null = null;
  const activeContentIndexes = new Set<number>();

  let lastAssistantMessage: ChatTimelineMessage | null = null;
  let messageEndFired = false;

  const removeSnapshotProvider = wsHub.setConversationSnapshotProvider(session.sessionId, () => {
    if (!currentStreamingMessageId || !currentStreamingMessage) return undefined;
    const createdAt = extractTimestamp(currentStreamingMessage, new Date().toISOString());
    return {
      type: "assistant_message_snapshot",
      piSessionId: session.sessionId,
      messageId: currentStreamingMessageId,
      blocks: currentStreamingMessage.content.map((content, contentIndex) => {
        const active = activeContentIndexes.has(contentIndex);
        const displayArgs =
          content.type === "toolCall"
            ? toolDisplayCache.displayArgsForTool(
                session.sessionId,
                content.name,
                content.arguments,
              )
            : undefined;
        const tool =
          content.type === "toolCall" ? timelineTool(content, createdAt, displayArgs) : undefined;
        return {
          block: timelineBlock(content),
          ...(tool ? { tool } : {}),
          active,
        };
      }),
    };
  });

  const unsubscribe = session.subscribe((event) => {
    const now = state.noteEvent(session.messages.length);

    switch (event.type) {
      case "message_start": {
        const role = extractMessageRole(event.message);
        const preferredId =
          role === "user" ? state.peekUserMessageItem()?.serverMessageId : undefined;
        const messageId = ensureConversationMessageId(event.message, preferredId);
        if (role === "assistant") {
          currentStreamingMessageId = messageId ?? null;
          currentStreamingMessage = event.message as AssistantMessage;
          activeContentIndexes.clear();
        }
        break;
      }
      case "message_update": {
        const messageId = currentStreamingMessageId;
        if (!messageId) break;
        const ame = event.assistantMessageEvent;
        if ("partial" in ame) currentStreamingMessage = ame.partial;

        switch (ame.type) {
          case "text_start":
          case "thinking_start":
          case "toolcall_start": {
            const content = ame.partial.content[ame.contentIndex];
            if (!content) break;
            activeContentIndexes.add(ame.contentIndex);
            const displayArgs =
              content.type === "toolCall"
                ? toolDisplayCache.displayArgsForTool(
                    session.sessionId,
                    content.name,
                    content.arguments,
                  )
                : undefined;
            const tool =
              content.type === "toolCall" ? timelineTool(content, now, displayArgs) : undefined;
            wsHub.broadcast({
              type: "assistant_block_set",
              piSessionId: session.sessionId,
              messageId,
              contentIndex: ame.contentIndex,
              block: timelineBlock(content),
              ...(tool ? { tool } : {}),
              active: true,
            });
            break;
          }
          case "text_delta":
          case "thinking_delta":
            wsHub.broadcast({
              type: "assistant_block_delta",
              piSessionId: session.sessionId,
              messageId,
              contentIndex: ame.contentIndex,
              blockType: ame.type === "text_delta" ? "text" : "thinking",
              delta: ame.delta,
            });
            break;
          case "toolcall_delta": {
            const content = ame.partial.content[ame.contentIndex];
            if (content?.type !== "toolCall") break;
            activeContentIndexes.add(ame.contentIndex);
            const displayArgs = toolDisplayCache.displayArgsForTool(
              session.sessionId,
              content.name,
              content.arguments,
            );
            const tool = timelineTool(content, now, displayArgs);
            wsHub.broadcast({
              type: "assistant_block_set",
              piSessionId: session.sessionId,
              messageId,
              contentIndex: ame.contentIndex,
              block: timelineBlock(content),
              ...(tool ? { tool } : {}),
              active: true,
            });
            break;
          }
          case "text_end":
            activeContentIndexes.delete(ame.contentIndex);
            wsHub.broadcast({
              type: "assistant_block_set",
              piSessionId: session.sessionId,
              messageId,
              contentIndex: ame.contentIndex,
              block: { type: "text", text: ame.content },
              active: false,
            });
            break;
          case "thinking_end":
            activeContentIndexes.delete(ame.contentIndex);
            wsHub.broadcast({
              type: "assistant_block_set",
              piSessionId: session.sessionId,
              messageId,
              contentIndex: ame.contentIndex,
              block: { type: "thinking", thinking: ame.content },
              active: false,
            });
            break;
          case "toolcall_end": {
            activeContentIndexes.delete(ame.contentIndex);
            const displayArgs = toolDisplayCache.displayArgsForTool(
              session.sessionId,
              ame.toolCall.name,
              ame.toolCall.arguments,
            );
            const tool = timelineTool(ame.toolCall, now, displayArgs);
            wsHub.broadcast({
              type: "assistant_block_set",
              piSessionId: session.sessionId,
              messageId,
              contentIndex: ame.contentIndex,
              block: timelineBlock(ame.toolCall),
              ...(tool ? { tool } : {}),
              active: false,
            });
            break;
          }
        }
        break;
      }
      case "message_end": {
        const customMessage = flitterbotHookToTimelineMessage(event.message, {
          fallbackId: ensureConversationMessageId(event.message),
          fallbackTimestamp: now,
        });
        if (customMessage) {
          wsHub.broadcastHistoryCommit({
            type: "message_end",
            piSessionId: session.sessionId,
            items: [customMessage],
          });
          break;
        }

        const anyRole = extractAnyMessageRole(event.message);
        if (!anyRole) break;

        const capturedRole = anyRole;
        const preferredId =
          capturedRole === "assistant"
            ? (currentStreamingMessageId ?? undefined)
            : capturedRole === "user"
              ? state.peekUserMessageItem()?.serverMessageId
              : undefined;
        const capturedMessage = event.message;
        const capturedMessageId = ensureConversationMessageId(capturedMessage, preferredId);
        const capturedTimestamp = extractTimestamp(event.message, now);
        currentStreamingMessageId = null;
        currentStreamingMessage = null;
        activeContentIndexes.clear();

        if (!capturedMessageId) {
          reportMissingPersistedMessage(wsHub, session.sessionId, capturedMessageId);
          break;
        }

        const role =
          capturedRole === "user" || capturedRole === "assistant" ? capturedRole : undefined;
        const currentItem = role === "user" ? state.takeUserMessageItem() : undefined;
        const fallbackImages = currentItem?.images?.map(({ data, mimeType }) => ({
          data,
          mimeType,
        }));
        const timelineItems = piMessageToTimelineItems(capturedMessage, {
          messageId: capturedMessageId,
          createdAt: capturedTimestamp,
          fallbackImages,
        });

        if (capturedRole === "toolResult") {
          const toolResult = timelineItems[0];
          if (toolResult?.kind !== "tool") break;
          queueMicrotask(() => {
            const entry = findConversationEntry(session.sessionManager, capturedMessageId);
            if (!entry) {
              reportMissingPersistedMessage(wsHub, session.sessionId, capturedMessageId);
              return;
            }
            wsHub.broadcastHistoryCommit({
              type: "tool_result",
              piSessionId: session.sessionId,
              item: { ...toolResult, piEntryId: entry.id },
            });
          });
          break;
        }

        if (!role) break;
        const message = timelineItems.find(
          (item): item is ChatTimelineMessage => item.kind === "message",
        );
        if (!message) {
          if (role === "assistant") {
            lastAssistantMessage = null;
            messageEndFired = true;
            wsHub.broadcastHistoryCommit({
              type: "message_end",
              piSessionId: session.sessionId,
              items: [],
            });
          }
          break;
        }
        const timelineMessage: ChatTimelineMessage = {
          ...message,
          source: currentItem?.source,
          streamId: currentItem?.streamId ?? sessionStreamId ?? undefined,
          streamName: currentItem?.streamName ?? sessionStreamName ?? undefined,
        };
        const toolItems = timelineItems
          .filter((item): item is ChatTimelineTool => item.kind === "tool")
          .map((item) => {
            const displayArgs = toolDisplayCache.displayArgsForTool(
              session.sessionId,
              item.tool,
              item.args,
            );
            return displayArgs ? { ...item, displayArgs } : item;
          });
        const committedItems = [timelineMessage, ...toolItems];

        if (role === "assistant") {
          lastAssistantMessage = timelineMessage;
          messageEndFired = true;
        } else {
          broadcastSurfaced(wsHub, session.sessionId, timelineMessage);
        }

        queueMicrotask(() => {
          const entry = findConversationEntry(session.sessionManager, capturedMessageId);
          if (!entry) {
            reportMissingPersistedMessage(wsHub, session.sessionId, capturedMessageId);
            return;
          }
          wsHub.broadcastHistoryCommit({
            type: "message_end",
            piSessionId: session.sessionId,
            items: committedItems.map((item) => ({ ...item, piEntryId: entry.id })),
          });
          if (role === "assistant") {
            wsHub.broadcast({
              type: "status_changed",
              subsystem: "pi",
              timestamp: new Date().toISOString(),
            });
          }
        });
        break;
      }
      case "tool_execution_start": {
        const args = event.args;
        const toolName = event.toolName;
        const displayArgs = toolName
          ? toolDisplayCache.displayArgsForTool(session.sessionId, toolName, args)
          : undefined;
        wsHub.broadcast({
          type: "tool_execution_start",
          piSessionId: session.sessionId,
          tool: toolName,
          toolUseId: event.toolCallId,
          args,
          ...(displayArgs ? { displayArgs } : {}),
          timestamp: now,
        });
        break;
      }
      case "tool_execution_end": {
        wsHub.broadcast({
          type: "tool_execution_end",
          piSessionId: session.sessionId,
          tool: event.toolName,
          toolUseId: event.toolCallId,
          result: event.result,
          isError: event.isError,
          timestamp: now,
        });
        break;
      }
      case "tool_execution_update": {
        if (!hasPartialContent(event.partialResult)) break;
        wsHub.broadcast({
          type: "tool_execution_update",
          piSessionId: session.sessionId,
          toolUseId: event.toolCallId,
          partialResult: event.partialResult,
          timestamp: now,
        });
        break;
      }
      case "turn_start":
        touchPiEvent(blackboard, session.sessionId, now, "active");
        console.log("streams-subscribe: %s (sessionId=%s)", event.type, session.sessionId);
        break;
      case "turn_end": {
        touchPiEvent(blackboard, session.sessionId, now, "active");
        currentStreamingMessageId = null;

        wsHub.broadcast({
          type: "turn_end",
          piSessionId: session.sessionId,
          timestamp: now,
        });
        break;
      }
      case "agent_start":
        touchPiEvent(blackboard, session.sessionId, now, "active");
        lastAssistantMessage = null;
        messageEndFired = false;
        wsHub.broadcast({
          type: "status_changed",
          subsystem: "pi_session",
          timestamp: now,
        });
        break;
      case "agent_end": {
        touchPiEvent(blackboard, session.sessionId, now, "active");
        wsHub.broadcast({
          type: "agent_end",
          piSessionId: session.sessionId,
          ...(messageEndFired ? {} : { aborted: true }),
        });
        const pendingSurface = selectCompletedAssistantMessage(
          event.messages,
          lastAssistantMessage,
        );
        lastAssistantMessage = null;
        messageEndFired = false;
        lifecycle.onAgentEnd?.(pendingSurface);
        break;
      }
      case "agent_settled":
        console.log("streams-subscribe: %s (sessionId=%s)", event.type, session.sessionId);
        lifecycle.onAgentSettled?.();
        break;
      case "compaction_start":
        wsHub.broadcast({
          type: "compaction_start",
          piSessionId: session.sessionId,
          reason: event.reason,
        });
        queueMicrotask(() => {
          wsHub.broadcast({
            type: "status_changed",
            subsystem: "pi",
            timestamp: new Date().toISOString(),
          });
        });
        break;
      case "compaction_end":
        wsHub.broadcast({
          type: "compaction_end",
          piSessionId: session.sessionId,
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
        });
        if (event.result && !event.aborted) {
          wsHub.broadcastHistoryCommit({
            type: "history_rewritten",
            piSessionId: session.sessionId,
            reason: "compact",
          });
        }
        queueMicrotask(() => {
          wsHub.broadcast({
            type: "status_changed",
            subsystem: "pi",
            timestamp: new Date().toISOString(),
          });
        });
        break;
      case "auto_retry_start":
      case "auto_retry_end":
        console.log("streams-subscribe: %s (sessionId=%s)", event.type, session.sessionId);
        break;
      default:
        console.warn(
          "streams-subscribe: unhandled event type=%s (sessionId=%s)",
          event.type,
          session.sessionId,
        );
        break;
    }
  });

  return () => {
    unsubscribe();
    removeSnapshotProvider();
  };
}
