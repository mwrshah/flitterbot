import type { BlackboardDatabase } from "../blackboard/db.ts";
import { touchPiEvent } from "../blackboard/pi-sessions.ts";
import type {
  ChatTimelineMessage,
  ControlSurfaceWebSocketServerEvent,
  MessageEndWebSocketEvent,
  StreamSurfacedWebSocketEvent,
  ThinkingEndWebSocketEvent,
  ThinkingStartWebSocketEvent,
  ToolCallStartWebSocketEvent,
  ToolExecutionEndWebSocketEvent,
  ToolExecutionStartWebSocketEvent,
  ToolExecutionUpdateWebSocketEvent,
  ToolResultWebSocketEvent,
  TurnEndWebSocketEvent,
} from "../contracts/index.ts";
import type { WebSocketHub } from "../ws/hub.ts";
import { toolResultMessageToTimelineItem } from "./history.ts";
import type { PiSessionState } from "./pi-session-state.ts";
import type { ToolDisplayContextCache } from "./tool-display.ts";

type PiSessionSubscriptionEvent =
  | {
      type: "message_start";
      message?: unknown;
      [key: string]: unknown;
    }
  | {
      type: "message_update";
      message?: unknown;
      assistantMessageEvent?: {
        type?: string;
        delta?: string;
        contentIndex?: number;
      };
    }
  | {
      type: "message_end";
      message?: unknown;
    }
  | {
      type: "tool_execution_start";
      toolName?: string;
      toolCallId?: string;
      parameters?: unknown;
      args?: unknown;
      [key: string]: unknown;
    }
  | {
      type: "tool_execution_end";
      toolName?: string;
      toolCallId?: string;
      result?: unknown;
      isError?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "tool_execution_update";
      toolName?: string;
      toolCallId?: string;
      partialResult?: unknown;
      [key: string]: unknown;
    }
  | {
      type: "turn_start";
      [key: string]: unknown;
    }
  | {
      type: "turn_end";
      [key: string]: unknown;
    }
  | {
      type: "agent_start";
      [key: string]: unknown;
    }
  | {
      type: "agent_end";
      [key: string]: unknown;
    }
  | {
      type: "compaction_start";
      [key: string]: unknown;
    }
  | {
      type: "compaction_end";
      [key: string]: unknown;
    }
  | {
      type: "auto_retry_start";
      [key: string]: unknown;
    }
  | {
      type: "auto_retry_end";
      [key: string]: unknown;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

type SubscribablePiSession = {
  sessionId: string;
  messages: Array<unknown>;
  subscribe: (listener: (event: PiSessionSubscriptionEvent) => void) => () => void;
  sessionManager: { getLeafId: () => string | null };
};

function hasPartialContent(partial: unknown): boolean {
  if (partial == null) return false;
  if (typeof partial !== "object") return true;
  const r = partial as Record<string, unknown>;
  if ("content" in r) return Array.isArray(r.content) && r.content.length > 0;
  return Object.keys(r).length > 0;
}

function broadcast(wsHub: WebSocketHub, payload: ControlSurfaceWebSocketServerEvent): void {
  wsHub.broadcast(payload);
}

function broadcastSurfaced(
  wsHub: WebSocketHub,
  piSessionId: string,
  message: ChatTimelineMessage,
): void {
  const payload: StreamSurfacedWebSocketEvent = {
    type: "stream_surfaced",
    piSessionId,
    message,
    streamId: message.streamId,
    streamName: message.streamName,
  };
  broadcast(wsHub, payload);
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
  session: SubscribablePiSession,
  state: PiSessionState,
  blackboard: BlackboardDatabase,
  wsHub: WebSocketHub,
  toolDisplayCache: ToolDisplayContextCache,
  sessionStreamId?: string | null,
  sessionStreamName?: string | null,
  onAgentEnd?: (lastAssistantMessage: ChatTimelineMessage | null) => void,
): () => void {
  // transient streaming key for one message_start/message_end window; the timeline persists the SDK entry.id (getLeafId()) instead
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
        const ame = event.assistantMessageEvent as
          | { type?: string; delta?: string; contentIndex?: number }
          | undefined;
        if (!ame?.type) break;

        if (
          ame.type === "text_delta" &&
          typeof ame.delta === "string" &&
          currentStreamingMessageId
        ) {
          broadcast(wsHub, {
            type: "text_delta",
            piSessionId: session.sessionId,
            messageId: currentStreamingMessageId,
            delta: ame.delta,
          });
        } else if (ame.type === "thinking_start" && currentStreamingMessageId) {
          const payload: ThinkingStartWebSocketEvent = {
            type: "thinking_start",
            piSessionId: session.sessionId,
            messageId: currentStreamingMessageId,
          };
          broadcast(wsHub, payload);
        } else if (
          ame.type === "thinking_delta" &&
          typeof ame.delta === "string" &&
          currentStreamingMessageId
        ) {
          broadcast(wsHub, {
            type: "thinking_delta",
            piSessionId: session.sessionId,
            messageId: currentStreamingMessageId,
            delta: ame.delta,
          });
        } else if (ame.type === "thinking_end" && currentStreamingMessageId) {
          const payload: ThinkingEndWebSocketEvent = {
            type: "thinking_end",
            piSessionId: session.sessionId,
            messageId: currentStreamingMessageId,
          };
          broadcast(wsHub, payload);
        } else if (ame.type === "toolcall_start" && typeof ame.contentIndex === "number") {
          let toolName: string | undefined;
          let toolUseId: string | undefined;
          const msg = event.message as
            | { content?: Array<{ name?: string; id?: string }> }
            | undefined;
          const block = msg?.content?.[ame.contentIndex];
          if (block) {
            toolName = block.name;
            toolUseId = block.id;
          }
          const payload: ToolCallStartWebSocketEvent = {
            type: "toolcall_start",
            piSessionId: session.sessionId,
            contentIndex: ame.contentIndex,
            toolName,
            toolUseId,
          };
          broadcast(wsHub, payload);
        }
        break;
      }
      case "message_end": {
        const anyRole = extractAnyMessageRole(event.message);
        if (!anyRole) break;

        // defer to microtask so the SDK's appendMessage runs first, making getLeafId() available
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
              const payload: ToolResultWebSocketEvent = {
                type: "tool_result",
                piSessionId: session.sessionId,
                item,
              };
              broadcast(wsHub, payload);
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
            const payload: MessageEndWebSocketEvent = {
              type: "message_end",
              piSessionId: session.sessionId,
              message: { ...timelineMessage, intermediate: true },
              ...(capturedToolCalls ? { toolCalls: capturedToolCalls } : {}),
            };
            broadcast(wsHub, payload);
            lastAssistantMessage = timelineMessage;
            messageEndFired = true;
          } else {
            const payload: MessageEndWebSocketEvent = {
              type: "message_end",
              piSessionId: session.sessionId,
              message: timelineMessage,
              ...(capturedClientMessageId ? { clientMessageId: capturedClientMessageId } : {}),
            };
            broadcast(wsHub, payload);
            broadcastSurfaced(wsHub, session.sessionId, timelineMessage);
          }
        });
        break;
      }
      case "tool_execution_start": {
        const args = event.args ?? event.parameters;
        const toolName = event.toolName as string | undefined;
        const displayArgs = toolName
          ? toolDisplayCache.displayArgsForTool(session.sessionId, toolName, args)
          : undefined;
        const payload: ToolExecutionStartWebSocketEvent = {
          type: "tool_execution_start",
          piSessionId: session.sessionId,
          tool: toolName,
          toolUseId: event.toolCallId as string | undefined,
          args,
          ...(displayArgs ? { displayArgs } : {}),
          timestamp: now,
          event,
        };
        broadcast(wsHub, payload);
        break;
      }
      case "tool_execution_end": {
        const payload: ToolExecutionEndWebSocketEvent = {
          type: "tool_execution_end",
          piSessionId: session.sessionId,
          tool: event.toolName as string | undefined,
          toolUseId: event.toolCallId as string | undefined,
          result: event.result,
          isError: event.isError as boolean | undefined,
          timestamp: now,
          event,
        };
        broadcast(wsHub, payload);
        break;
      }
      case "tool_execution_update": {
        if (!hasPartialContent(event.partialResult)) break;
        const payload: ToolExecutionUpdateWebSocketEvent = {
          type: "tool_execution_update",
          piSessionId: session.sessionId,
          toolUseId: event.toolCallId as string | undefined,
          partialResult: event.partialResult,
          timestamp: now,
          event,
        };
        broadcast(wsHub, payload);
        break;
      }
      case "turn_start":
        touchPiEvent(blackboard, session.sessionId, now, "active");
        console.log("streams-subscribe: %s (sessionId=%s)", event.type, session.sessionId);
        break;
      case "turn_end": {
        touchPiEvent(blackboard, session.sessionId, now, "active");
        currentStreamingMessageId = null;

        const payload: TurnEndWebSocketEvent = {
          type: "turn_end",
          piSessionId: session.sessionId,
          timestamp: now,
          event,
        };
        broadcast(wsHub, payload);
        break;
      }
      case "agent_start":
        touchPiEvent(blackboard, session.sessionId, now, "active");
        lastAssistantMessage = null;
        messageEndFired = false;
        break;
      case "agent_end": {
        touchPiEvent(blackboard, session.sessionId, now, "active");
        broadcast(wsHub, {
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
