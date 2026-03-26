import type { BlackboardDatabase } from "../blackboard/db.ts";
import { touchPiEvent } from "../blackboard/pi-sessions.ts";
import type {
  ChatTimelineMessage,
  ControlSurfaceWebSocketServerEvent,
  MessageEndWebSocketEvent,
  ToolExecutionEndWebSocketEvent,
  ToolExecutionStartWebSocketEvent,
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
      type: "turn_end" | "agent_end";
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
  // Deferred assistant messages: accumulate during a turn, flush on turn_end.
  // Earlier ones get broadcast with intermediate: true; only the last one is final.
  const pendingAssistantMessages: ChatTimelineMessage[] = [];

  // Ordinal counter: starts at session.messages.length to account for pre-existing messages.
  // Incremented on every message_end (user, assistant, toolResult) to produce deterministic
  // msg-N IDs that match the history path in history.ts.
  let messageOrdinal = session.messages.length;

  // Tracks the ordinal ID for the currently-streaming assistant message.
  // Set on message_start (assistant only), cleared on message_end / turn_end.
  let currentStreamingMessageId: string | null = null;

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
        const ame = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (
          ame?.type === "text_delta" &&
          typeof ame.delta === "string" &&
          currentStreamingMessageId
        ) {
          broadcast(wsHub, {
            type: "text_delta",
            sessionId: session.sessionId,
            messageId: currentStreamingMessageId,
            delta: ame.delta,
          });
        }
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
          // Defer — accumulate until turn_end so we can mark intermediate vs final
          pendingAssistantMessages.push(timelineMessage);
        } else {
          const payload: MessageEndWebSocketEvent = {
            type: "message_end",
            sessionId: session.sessionId,
            message: timelineMessage,
          };
          broadcast(wsHub, payload);
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
      case "turn_end": {
        // Flush deferred assistant messages: all but last are intermediate
        for (let i = 0; i < pendingAssistantMessages.length; i++) {
          const isLast = i === pendingAssistantMessages.length - 1;
          const msg = isLast
            ? pendingAssistantMessages[i]!
            : { ...pendingAssistantMessages[i]!, intermediate: true };
          const payload: MessageEndWebSocketEvent = {
            type: "message_end",
            sessionId: session.sessionId,
            message: msg,
          };
          broadcast(wsHub, payload);
        }
        pendingAssistantMessages.length = 0;
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
      default:
        break;
    }
  });
}
