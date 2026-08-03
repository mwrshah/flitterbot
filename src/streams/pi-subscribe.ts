import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { touchPiEvent } from "../blackboard/pi-sessions.ts";
import type { ChatTimelineMessage } from "../contracts/index.ts";
import type { WebSocketHub } from "../ws/hub.ts";
import { parseUsage, toolResultMessageToTimelineItem } from "./history.ts";
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

type MessageBlock = { type: "text"; text: string } | { type: "thinking"; thinking: string };
type ExtractedToolCall = {
  toolUseId: string;
  toolName: string;
  args?: unknown;
  displayArgs?: unknown;
};

function extractMessageBlocks(message: unknown): {
  text: string | undefined;
  blocks: MessageBlock[];
  toolCalls: ExtractedToolCall[];
} {
  if (!message || typeof message !== "object")
    return { text: undefined, blocks: [], toolCalls: [] };

  const record = message as Record<string, unknown>;
  const content = record.content;

  if (Array.isArray(content)) {
    const blocks: MessageBlock[] = [];
    const toolCalls: ExtractedToolCall[] = [];
    let textBuffer = "";

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        textBuffer += item.text;
        blocks.push({ type: "text", text: item.text });
      } else if (item.type === "thinking" && typeof item.thinking === "string") {
        if (item.thinking.trim()) {
          blocks.push({ type: "thinking", thinking: item.thinking });
        }
      } else if (
        item.type === "toolCall" &&
        typeof item.id === "string" &&
        typeof item.name === "string"
      ) {
        toolCalls.push({
          toolUseId: item.id,
          toolName: item.name,
          args: item.arguments as unknown,
        });
      }
    }

    const text = textBuffer.trim().length > 0 ? textBuffer : undefined;
    return { text, blocks, toolCalls };
  }

  const directText = [record.text, record.message].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return {
    text: directText,
    blocks: directText ? [{ type: "text", text: directText }] : [],
    toolCalls: [],
  };
}

function _extractMessageId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const id = (message as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id : undefined;
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
): () => void {
  let streamingKeyCounter = session.messages.length;
  let currentStreamingMessageId: string | null = null;

  let lastAssistantMessage: ChatTimelineMessage | null = null;
  let messageEndFired = false;

  return session.subscribe((event) => {
    const now = state.noteEvent(session.messages.length);

    switch (event.type) {
      case "message_start": {
        const role = extractMessageRole(event.message);
        if (role === "assistant") {
          currentStreamingMessageId = `streaming-${streamingKeyCounter}`;
          streamingKeyCounter += 1;
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
        const anyRole = extractAnyMessageRole(event.message);
        if (!anyRole) break;

        const capturedMessage = event.message;
        const capturedTimestamp = extractTimestamp(event.message, now);
        const capturedRole = anyRole;
        currentStreamingMessageId = null;

        if (capturedRole === "toolResult") {
          queueMicrotask(() => {
            const entryId = session.sessionManager.getLeafId();
            if (!entryId) return;
            const item = toolResultMessageToTimelineItem(
              capturedMessage,
              entryId,
              capturedTimestamp,
            );
            if (item) {
              wsHub.broadcast({
                type: "tool_result",
                piSessionId: session.sessionId,
                item,
              });
            }
          });
          break;
        }

        const role =
          capturedRole === "user" || capturedRole === "assistant" ? capturedRole : undefined;
        const { text: content, blocks, toolCalls } = extractMessageBlocks(capturedMessage);
        if (!role || (!content && blocks.length === 0)) break;

        const currentItem = role === "user" ? state.getSnapshot().currentItem : undefined;
        const capturedSource = currentItem?.source;
        const capturedStreamId = currentItem?.streamId ?? sessionStreamId ?? undefined;
        const capturedStreamName = currentItem?.streamName ?? sessionStreamName ?? undefined;
        const capturedServerMessageId = currentItem?.serverMessageId;
        const capturedClientMessageId = currentItem?.clientMessageId;
        const capturedHasThinking = blocks.some((b) => b.type === "thinking");
        const capturedBlocks = capturedHasThinking ? blocks : undefined;
        const enrichedToolCalls: ExtractedToolCall[] = toolCalls.map((tc) => {
          const display = toolDisplayCache.displayArgsForTool(
            session.sessionId,
            tc.toolName,
            tc.args,
          );
          return display ? { ...tc, displayArgs: display } : tc;
        });
        const capturedToolCalls = enrichedToolCalls.length > 0 ? enrichedToolCalls : undefined;

        queueMicrotask(() => {
          const entryId = session.sessionManager.getLeafId();
          if (!entryId) return;

          const timelineMessage: ChatTimelineMessage = {
            id: entryId,
            kind: "message",
            role,
            content: content ?? "",
            source: capturedSource,
            streamId: capturedStreamId,
            streamName: capturedStreamName,
            serverMessageId: capturedServerMessageId,
            createdAt: capturedTimestamp,
          };
          if (capturedBlocks) {
            timelineMessage.blocks = capturedBlocks;
          }

          if (role === "assistant") {
            const usage = parseUsage((capturedMessage as { usage?: unknown }).usage);
            if (usage) {
              timelineMessage.usage = usage;
            }
            wsHub.broadcast({
              type: "message_end",
              piSessionId: session.sessionId,
              message: { ...timelineMessage, intermediate: true },
              ...(capturedToolCalls ? { toolCalls: capturedToolCalls } : {}),
            });
            lastAssistantMessage = timelineMessage;
            messageEndFired = true;
          } else {
            wsHub.broadcast({
              type: "message_end",
              piSessionId: session.sessionId,
              message: timelineMessage,
              ...(capturedClientMessageId ? { clientMessageId: capturedClientMessageId } : {}),
            });
            broadcastSurfaced(wsHub, session.sessionId, timelineMessage);
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
