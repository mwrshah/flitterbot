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
  /** Pi SDK session ID — equals piSessionId in the database */
  sessionId: string;
  messages: Array<unknown>;
  subscribe: (listener: (event: PiSessionSubscriptionEvent) => void) => () => void;
};

/**
 * Returns true if a tool_execution_update partial result contains actual data
 * worth forwarding. Filters out empty shells like { content: [] }.
 */
function hasPartialContent(partial: unknown): boolean {
  if (partial == null) return false;
  if (typeof partial !== "object") return true; // primitive value — meaningful
  const r = partial as Record<string, unknown>;
  // { content: [...] } shape — only meaningful if the array is non-empty
  if ("content" in r) return Array.isArray(r.content) && r.content.length > 0;
  // Any other object with at least one key is considered meaningful
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
type ExtractedToolCall = { toolUseId: string; toolName: string; args?: unknown };

/**
 * Extract structured blocks (text + thinking) and tool calls from a message's
 * content array. Returns the display text, blocks array, and any tool calls.
 * Thinking-only messages return empty text but non-empty blocks.
 */
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

  // Fall back to scalar text fields for non-content-array message shapes.
  // errorMessage is intentionally excluded — it's an SDK-internal diagnostic string
  // (e.g. "Request was aborted.") not intended for display.
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
  sessionStreamId?: string | null,
  sessionStreamName?: string | null,
  onAgentEnd?: () => void,
): () => void {
  // Ordinal counter: starts at session.messages.length to account for pre-existing messages.
  // Incremented on every message_end (user, assistant, toolResult) to produce deterministic
  // msg-N IDs that match the history path in history.ts.
  let messageOrdinal = session.messages.length;

  // Tracks the ordinal ID for the currently-streaming assistant message.
  // Set on message_start (assistant only), cleared on message_end / turn_end.
  let currentStreamingMessageId: string | null = null;

  // Tracks the last assistant message in the current agent run.
  // Reset on agent_start; used on agent_end to re-broadcast as final + stream_surfaced.
  let lastAssistantMessage: ChatTimelineMessage | null = null;

  // True when at least one assistant message_end fired in the current agent run.
  // Reset on agent_start; checked on agent_end to detect aborted runs.
  let messageEndFired = false;

  return session.subscribe((event) => {
    const now = state.noteEvent(session.messages.length);
    // FR-3: Update last_event_at only on turn/agent boundary events (not per-delta).
    // Post-turn status transitions (waiting_for_user/waiting_for_sessions) are handled
    // by runtime.transitionPiAfterTurn(), not the event subscriber.

    switch (event.type) {
      case "message_start": {
        const role = extractMessageRole(event.message);
        if (role === "assistant") {
          // Pre-assign the ordinal ID for this message so text_delta events can carry it.
          // The counter is incremented now; message_end will use this same ID.
          currentStreamingMessageId = `msg-${messageOrdinal}`;
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
          // Extract toolName and toolUseId from the partial message's content block.
          // At content_block_start the SDK populates id + name but not arguments.
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
        // toolcall_delta (input_json_delta) intentionally suppressed —
        // tool args arrive via tool_execution_start instead.
        break;
      }
      case "message_end": {
        const anyRole = extractAnyMessageRole(event.message);
        if (!anyRole) break;

        // Always increment ordinal for every message role (user, assistant, toolResult)
        // to stay in sync with history.ts which counts all type: "message" entries.
        const messageId = currentStreamingMessageId ?? `msg-${messageOrdinal}`;
        messageOrdinal += 1;
        currentStreamingMessageId = null;

        if (anyRole === "toolResult") {
          const item = toolResultMessageToTimelineItem(
            event.message,
            messageId,
            extractTimestamp(event.message, now),
          );
          if (item) {
            const payload: ToolResultWebSocketEvent = {
              type: "tool_result",
              piSessionId: session.sessionId,
              item,
            };
            broadcast(wsHub, payload);
          }
          break;
        }

        const role = anyRole === "user" || anyRole === "assistant" ? anyRole : undefined;
        const { text: content, blocks, toolCalls } = extractMessageBlocks(event.message);
        // Allow thinking-only messages (content empty but blocks non-empty) through.
        if (!role || (!content && blocks.length === 0)) break;

        const currentItem = role === "user" ? state.getSnapshot().currentItem : undefined;
        const timelineMessage: ChatTimelineMessage = {
          id: messageId,
          kind: "message",
          role,
          content: content ?? "",
          source: currentItem?.source,
          streamId: currentItem?.streamId ?? sessionStreamId ?? undefined,
          streamName: currentItem?.streamName ?? sessionStreamName ?? undefined,
          serverMessageId: currentItem?.serverMessageId,
          createdAt: extractTimestamp(event.message, now),
        };
        // Include blocks when there are thinking blocks (text-only messages
        // don't need blocks — content already carries the text).
        if (blocks.some((b) => b.type === "thinking")) {
          timelineMessage.blocks = blocks;
        }

        if (role === "assistant") {
          // Broadcast immediately with intermediate flag so the session view gets it live.
          // The final correction (without intermediate) happens on agent_end.
          const payload: MessageEndWebSocketEvent = {
            type: "message_end",
            piSessionId: session.sessionId,
            message: { ...timelineMessage, intermediate: true },
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          };
          broadcast(wsHub, payload);
          lastAssistantMessage = timelineMessage;
          messageEndFired = true;
        } else {
          const payload: MessageEndWebSocketEvent = {
            type: "message_end",
            piSessionId: session.sessionId,
            message: timelineMessage,
          };
          broadcast(wsHub, payload);
          broadcastSurfaced(wsHub, session.sessionId, timelineMessage);
        }
        break;
      }
      case "tool_execution_start": {
        const payload: ToolExecutionStartWebSocketEvent = {
          type: "tool_execution_start",
          piSessionId: session.sessionId,
          tool: event.toolName as string | undefined,
          toolUseId: event.toolCallId as string | undefined,
          args: event.args ?? event.parameters,
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
        // Only forward if the partial result has actual content — skip empty shells
        // like { content: [] } that carry no useful information.
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
        if (lastAssistantMessage) {
          broadcastSurfaced(wsHub, session.sessionId, lastAssistantMessage);
        }
        broadcast(wsHub, {
          type: "agent_end",
          piSessionId: session.sessionId,
          ...(messageEndFired ? {} : { aborted: true }),
        });
        lastAssistantMessage = null;
        messageEndFired = false;
        onAgentEnd?.();
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
