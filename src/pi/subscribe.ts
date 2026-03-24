import crypto from "node:crypto";
import { type BlackboardDatabase, insertIdMapping } from "../blackboard/db.ts";
import { touchPiEvent } from "../blackboard/pi-sessions.ts";
import type {
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

function extractMessageRole(message: unknown): "user" | "assistant" | undefined {
  if (!message || typeof message !== "object") return undefined;

  const role = (message as Record<string, unknown>).role;
  if (role === "user" || role === "assistant") {
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

function extractMessageId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  // Prefer responseId (Anthropic API response identifier, available on AssistantMessage since SDK 0.60)
  for (const key of ["responseId", "id"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
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
  session: SubscribablePiSession,
  state: PiSessionState,
  blackboard: BlackboardDatabase,
  wsHub: WebSocketHub,
): () => void {
  // Deferred assistant messages: accumulate during a turn, flush on turn_end.
  // Earlier ones get broadcast with intermediate: true; only the last one is final.
  const pendingAssistantMessages: MessageEndWebSocketEvent[] = [];

  // Pre-allocated server UUID for the current streaming assistant message.
  // Set when the first text_delta arrives for a new assistant message, used at message_end.
  let streamingServerUuid: string | null = null;
  let toolIndex = 0;

  return session.subscribe((event) => {
    const now = state.noteEvent(session.messages.length);
    // FR-3: Only set 'active' during turns. Post-turn transitions (waiting_for_user/waiting_for_sessions)
    // are handled by runtime.transitionPiAfterTurn(), not the event subscriber.
    if (event.type !== "turn_end" && event.type !== "agent_end") {
      touchPiEvent(blackboard, session.sessionId, now, "active");
    }

    switch (event.type) {
      case "message_update": {
        const ame = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          // Pre-allocate server UUID for this streaming message if not already set
          if (!streamingServerUuid) {
            streamingServerUuid = crypto.randomUUID();
          }
          broadcast(wsHub, {
            type: "text_delta",
            sessionId: session.sessionId,
            messageId: streamingServerUuid,
            delta: ame.delta,
          });
        }
        break;
      }
      case "message_end": {
        const role = extractMessageRole(event.message);
        const content = extractMessageText(event.message);
        if (!role || !content) {
          break;
        }

        const currentItem = role === "user" ? state.getSnapshot().currentItem : undefined;
        const agentMessageId = extractMessageId(event.message);

        // Resolve or create server UUID for this message
        let serverMessageId: string;
        if (role === "user") {
          // User messages: server UUID was assigned at ingestion, available in queue item metadata
          const snapshot = state.getSnapshot();
          serverMessageId = (snapshot.currentItem?.metadata?.serverMessageId as string) ?? crypto.randomUUID();
        } else {
          // Assistant messages: use pre-allocated streaming UUID if available, otherwise generate
          serverMessageId = streamingServerUuid ?? crypto.randomUUID();
          streamingServerUuid = null; // Reset for next message
        }

        // Insert agent→server UUID mapping when we have both IDs
        if (agentMessageId) {
          try {
            insertIdMapping(blackboard, serverMessageId, agentMessageId, session.sessionId);
          } catch {
            // Ignore duplicate insert errors
          }
        }

        const payload: MessageEndWebSocketEvent = {
          type: "message_end",
          sessionId: session.sessionId,
          messageId: serverMessageId,
          role,
          content,
          source: currentItem?.source,
          timestamp: extractTimestamp(event.message, now),
          workstreamId: currentItem?.workstreamId,
          workstreamName: currentItem?.workstreamName,
        };

        if (role === "assistant") {
          // Defer — accumulate until turn_end so we can mark intermediate vs final
          pendingAssistantMessages.push(payload);
        } else {
          broadcast(wsHub, payload);
        }
        break;
      }
      case "tool_execution_start": {
        // Deterministic tool ID for deduplication — must match history.ts format
        const toolCallId = event.toolCallId as string | undefined;
        const lastAssistantId = pendingAssistantMessages.length > 0
          ? pendingAssistantMessages[pendingAssistantMessages.length - 1]!.messageId
          : undefined;
        const anchorId = lastAssistantId ?? streamingServerUuid ?? session.sessionId;
        const deterministicId = toolCallId
          ? `${anchorId}:tool:${toolCallId}:start`
          : undefined;

        const payload: ToolExecutionStartWebSocketEvent = {
          type: "tool_execution_start",
          id: deterministicId,
          sessionId: session.sessionId,
          tool: event.toolName as string | undefined,
          toolUseId: toolCallId,
          args: event.args ?? event.parameters,
          timestamp: now,
          event,
        };
        broadcast(wsHub, payload);
        toolIndex += 1;
        break;
      }
      case "tool_execution_end": {
        const toolCallId = event.toolCallId as string | undefined;
        const lastAssistantId = pendingAssistantMessages.length > 0
          ? pendingAssistantMessages[pendingAssistantMessages.length - 1]!.messageId
          : undefined;
        const anchorId = lastAssistantId ?? streamingServerUuid ?? session.sessionId;
        const deterministicId = toolCallId
          ? `${anchorId}:tool:${toolCallId}:end`
          : undefined;

        const payload: ToolExecutionEndWebSocketEvent = {
          type: "tool_execution_end",
          id: deterministicId,
          sessionId: session.sessionId,
          tool: event.toolName as string | undefined,
          toolUseId: toolCallId,
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
          broadcast(
            wsHub,
            isLast
              ? pendingAssistantMessages[i]!
              : { ...pendingAssistantMessages[i]!, intermediate: true },
          );
        }
        pendingAssistantMessages.length = 0;
        toolIndex = 0;
        streamingServerUuid = null;

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
