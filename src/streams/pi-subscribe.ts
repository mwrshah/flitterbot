import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { touchPiEvent } from "../blackboard/pi-sessions.ts";
import type { ChatTimelineMessage, ChatTimelineTool } from "../contracts/index.ts";
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

type BroadcastRole = "user" | "assistant";
type AnyMessageRole = BroadcastRole | "toolResult";

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

export function subscribeToPiSession(
  session: AgentSession,
  state: PiSessionState,
  blackboard: BlackboardDatabase,
  wsHub: WebSocketHub,
  toolDisplayCache: ToolDisplayContextCache,
  sessionStreamId?: string | null,
  sessionStreamName?: string | null,
  onAgentEnd?: (lastAssistantMessage: ChatTimelineMessage | null) => void,
  onTurnEnd?: () => void,
  onAgentStart?: () => void,
): () => void {
  let currentStreamingMessageId: string | null = null;

  let lastAssistantMessage: ChatTimelineMessage | null = null;
  let messageEndFired = false;

  return session.subscribe((event) => {
    const now = state.noteEvent(session.messages.length);

    switch (event.type) {
      case "message_start": {
        const role = extractMessageRole(event.message);
        const preferredId =
          role === "user" ? state.peekUserMessageItem()?.serverMessageId : undefined;
        const messageId = ensureConversationMessageId(event.message, preferredId);
        if (role === "assistant") {
          currentStreamingMessageId = messageId ?? null;
        }
        break;
      }
      case "message_update": {
        const ame = event.assistantMessageEvent;

        if (
          ame.type === "text_delta" &&
          typeof ame.delta === "string" &&
          currentStreamingMessageId
        ) {
          wsHub.broadcast({
            type: "text_delta",
            piSessionId: session.sessionId,
            messageId: currentStreamingMessageId,
            delta: ame.delta,
          });
        } else if (ame.type === "thinking_start" && currentStreamingMessageId) {
          wsHub.broadcast({
            type: "thinking_start",
            piSessionId: session.sessionId,
            messageId: currentStreamingMessageId,
          });
        } else if (
          ame.type === "thinking_delta" &&
          typeof ame.delta === "string" &&
          currentStreamingMessageId
        ) {
          wsHub.broadcast({
            type: "thinking_delta",
            piSessionId: session.sessionId,
            messageId: currentStreamingMessageId,
            delta: ame.delta,
          });
        } else if (ame.type === "thinking_end" && currentStreamingMessageId) {
          wsHub.broadcast({
            type: "thinking_end",
            piSessionId: session.sessionId,
            messageId: currentStreamingMessageId,
          });
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
        if (!message) break;
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
        onTurnEnd?.();

        wsHub.broadcast({
          type: "turn_end",
          piSessionId: session.sessionId,
          timestamp: now,
        });
        break;
      }
      case "agent_start":
        touchPiEvent(blackboard, session.sessionId, now, "active");
        onAgentStart?.();
        lastAssistantMessage = null;
        messageEndFired = false;
        break;
      case "agent_end": {
        touchPiEvent(blackboard, session.sessionId, now, "active");
        wsHub.broadcast({
          type: "agent_end",
          piSessionId: session.sessionId,
          ...(messageEndFired ? {} : { aborted: true }),
        });
        const pendingSurface = lastAssistantMessage;
        lastAssistantMessage = null;
        messageEndFired = false;
        onAgentEnd?.(pendingSurface);
        break;
      }
      case "compaction_start":
      case "compaction_end":
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
}
