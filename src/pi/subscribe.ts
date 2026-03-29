import type { BlackboardDatabase } from "../blackboard/db.ts";
import { touchPiEvent } from "../blackboard/pi-sessions.ts";
import type {
  ChatTimelineMessage,
  ControlSurfaceWebSocketServerEvent,
  MessageEndWebSocketEvent,
  PiSurfacedWebSocketEvent,
  ToolCallStartWebSocketEvent,
  ToolExecutionEndWebSocketEvent,
  ToolExecutionStartWebSocketEvent,
  ToolExecutionUpdateWebSocketEvent,
  TurnEndWebSocketEvent,
} from "../contracts/index.ts";
import type { WebSocketHub } from "../ws/hub.ts";
import type { PiSessionState } from "./session-state.ts";

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
      type: "auto_compaction_start";
      [key: string]: unknown;
    }
  | {
      type: "auto_compaction_end";
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
};

function broadcast(wsHub: WebSocketHub, payload: ControlSurfaceWebSocketServerEvent): void {
  wsHub.broadcast(payload);
}

function broadcastSurfaced(
  wsHub: WebSocketHub,
  sessionId: string,
  message: ChatTimelineMessage,
): void {
  const payload: PiSurfacedWebSocketEvent = {
    type: "pi_surfaced",
    sessionId,
    message,
    workstreamId: message.workstreamId,
    workstreamName: message.workstreamName,
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

function extractMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;

  const record = message as Record<string, unknown>;
  const directText = [record.text, record.message, record.errorMessage].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (directText) return directText;

  const content = record.content;
  if (!Array.isArray(content)) return undefined;

  const parts = content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        return [item.text];
      }
      return [];
    })
    .join("");

  return parts.trim().length > 0 ? parts : undefined;
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
): () => void {
  // Ordinal counter: starts at session.messages.length to account for pre-existing messages.
  // Incremented on every message_end (user, assistant, toolResult) to produce deterministic
  // msg-N IDs that match the history path in history.ts.
  let messageOrdinal = session.messages.length;

  // Tracks the ordinal ID for the currently-streaming assistant message.
  // Set on message_start (assistant only), cleared on message_end / turn_end.
  let currentStreamingMessageId: string | null = null;

  // Tracks the last assistant message in the current agent run.
  // Reset on agent_start; used on agent_end to re-broadcast as final + pi_surfaced.
  let lastAssistantMessage: ChatTimelineMessage | null = null;

  return session.subscribe((event) => {
    const now = state.noteEvent(session.messages.length);
    // FR-3: Only set 'active' during turns. Post-turn transitions (waiting_for_user/waiting_for_sessions)
    // are handled by runtime.transitionPiAfterTurn(), not the event subscriber.
    if (event.type !== "turn_end" && event.type !== "agent_end") {
      touchPiEvent(blackboard, session.sessionId, now, "active");
    }

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

        if (ame.type === "text_delta" && typeof ame.delta === "string" && currentStreamingMessageId) {
          broadcast(wsHub, {
            type: "text_delta",
            sessionId: session.sessionId,
            messageId: currentStreamingMessageId,
            delta: ame.delta,
          });
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
            sessionId: session.sessionId,
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

        // Only broadcast user/assistant messages — toolResult is not surfaced via WS.
        const role = anyRole === "user" || anyRole === "assistant" ? anyRole : undefined;
        const content = extractMessageText(event.message);
        if (!role || !content) break;

        const currentItem = role === "user" ? state.getSnapshot().currentItem : undefined;
        const timelineMessage: ChatTimelineMessage = {
          id: messageId,
          kind: "message",
          role,
          content,
          source: currentItem?.source,
          workstreamId: currentItem?.workstreamId,
          workstreamName: currentItem?.workstreamName,
          createdAt: extractTimestamp(event.message, now),
        };

        if (role === "assistant") {
          // Broadcast immediately with intermediate flag so the session view gets it live.
          // The final correction (without intermediate) happens on agent_end.
          const payload: MessageEndWebSocketEvent = {
            type: "message_end",
            sessionId: session.sessionId,
            message: { ...timelineMessage, intermediate: true },
          };
          broadcast(wsHub, payload);
          lastAssistantMessage = timelineMessage;
        } else {
          const payload: MessageEndWebSocketEvent = {
            type: "message_end",
            sessionId: session.sessionId,
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
          sessionId: session.sessionId,
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
          sessionId: session.sessionId,
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
        const payload: ToolExecutionUpdateWebSocketEvent = {
          type: "tool_execution_update",
          sessionId: session.sessionId,
          toolUseId: event.toolCallId as string | undefined,
          partialResult: event.partialResult,
          timestamp: now,
          event,
        };
        broadcast(wsHub, payload);
        break;
      }
      case "turn_start":
        console.log("pi-subscribe: %s (sessionId=%s)", event.type, session.sessionId);
        break;
      case "turn_end": {
        currentStreamingMessageId = null;

        const payload: TurnEndWebSocketEvent = {
          type: "turn_end",
          sessionId: session.sessionId,
          timestamp: now,
          event,
        };
        broadcast(wsHub, payload);
        break;
      }
      case "agent_start":
        lastAssistantMessage = null;
        break;
      case "agent_end": {
        if (lastAssistantMessage) {
          // Re-broadcast final message_end without intermediate to correct the session view.
          const payload: MessageEndWebSocketEvent = {
            type: "message_end",
            sessionId: session.sessionId,
            message: lastAssistantMessage,
          };
          broadcast(wsHub, payload);
          broadcastSurfaced(wsHub, session.sessionId, lastAssistantMessage);
        }
        lastAssistantMessage = null;
        // Always broadcast agent_end so the frontend can flush any uncommitted streaming
        // text (e.g. when abort() causes runAgentLoop to throw, skipping message_end/turn_end).
        broadcast(wsHub, { type: "agent_end", sessionId: session.sessionId });
        break;
      }
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        console.log("pi-subscribe: %s (sessionId=%s)", event.type, session.sessionId);
        break;
      default:
        console.warn("pi-subscribe: unhandled event type=%s (sessionId=%s)", event.type, session.sessionId);
        break;
    }
  });
}
