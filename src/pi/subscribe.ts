import crypto from "node:crypto";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
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

/** Derived from AgentSessionEvent since pi-agent-core is not a direct dependency */
type AgentMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];

type SubscribablePiSession = {
  sessionId: string;
  messages: AgentMessage[];
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
};

function broadcast(wsHub: WebSocketHub, payload: ControlSurfaceWebSocketServerEvent): void {
  wsHub.broadcast(payload);
}

function extractMessageRole(message: AgentMessage): "user" | "assistant" | undefined {
  if (message.role === "user" || message.role === "assistant") {
    return message.role;
  }
  return undefined;
}

function extractMessageText(message: AgentMessage): string | undefined {
  if (message.role === "assistant") {
    if (message.errorMessage?.trim()) return message.errorMessage;
    const parts = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    return parts.trim().length > 0 ? parts : undefined;
  }

  if (message.role === "user") {
    if (typeof message.content === "string") {
      return message.content.trim().length > 0 ? message.content : undefined;
    }
    const parts = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    return parts.trim().length > 0 ? parts : undefined;
  }

  return undefined;
}

function extractMessageId(message: AgentMessage): string | undefined {
  // responseId is the Anthropic API response identifier, available on AssistantMessage since SDK 0.60
  if (message.role === "assistant" && message.responseId?.trim()) {
    return message.responseId;
  }
  return undefined;
}

function extractTimestamp(message: AgentMessage, fallback: string): string {
  if (Number.isFinite(message.timestamp)) {
    return new Date(message.timestamp).toISOString();
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
      const isTextDelta =
        event.type === "message_update" && event.assistantMessageEvent.type === "text_delta";
      if (!isTextDelta) {
        touchPiEvent(blackboard, session.sessionId, now, "active");
      }
    }

    switch (event.type) {
      case "message_update": {
        if (event.assistantMessageEvent.type === "text_delta") {
          // Pre-allocate server UUID for this streaming message if not already set
          if (!streamingServerUuid) {
            streamingServerUuid = crypto.randomUUID();
          }
          broadcast(wsHub, {
            type: "text_delta",
            sessionId: session.sessionId,
            messageId: streamingServerUuid,
            delta: event.assistantMessageEvent.delta,
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
          serverMessageId =
            (snapshot.currentItem?.metadata?.serverMessageId as string) ?? crypto.randomUUID();
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
        const toolCallId = event.toolCallId;
        const lastAssistantId =
          pendingAssistantMessages.length > 0
            ? pendingAssistantMessages[pendingAssistantMessages.length - 1]!.messageId
            : undefined;
        const anchorId = lastAssistantId ?? streamingServerUuid ?? session.sessionId;
        const deterministicId = toolCallId
          ? `${anchorId}:tool:${toolCallId}:start`
          : `${anchorId}:tool:pos-${toolIndex}:start`;

        const payload: ToolExecutionStartWebSocketEvent = {
          type: "tool_execution_start",
          id: deterministicId,
          sessionId: session.sessionId,
          tool: event.toolName,
          toolUseId: toolCallId,
          args: event.args,
          timestamp: now,
          event,
        };
        broadcast(wsHub, payload);
        toolIndex += 1;
        break;
      }
      case "tool_execution_end": {
        const toolCallId = event.toolCallId;
        const lastAssistantId =
          pendingAssistantMessages.length > 0
            ? pendingAssistantMessages[pendingAssistantMessages.length - 1]!.messageId
            : undefined;
        const anchorId = lastAssistantId ?? streamingServerUuid ?? session.sessionId;
        const deterministicId = toolCallId
          ? `${anchorId}:tool:${toolCallId}:end`
          : `${anchorId}:tool:pos-${toolIndex}:end`;

        const payload: ToolExecutionEndWebSocketEvent = {
          type: "tool_execution_end",
          id: deterministicId,
          sessionId: session.sessionId,
          tool: event.toolName,
          toolUseId: toolCallId,
          result: event.result,
          isError: event.isError,
          timestamp: now,
          event,
        };
        broadcast(wsHub, payload);
        break;
      }
      case "turn_end": {
        // The SDK fires turn_end after every API response — including mid-turn
        // tool-use stops. Only treat it as a real end-of-turn when the assistant's
        // stopReason is NOT "toolUse" (i.e. the model finished with text, not a
        // tool call that will be followed by tool execution and another turn).
        const turnMessage = event.message;
        const stopReason = turnMessage.role === "assistant" ? turnMessage.stopReason : undefined;

        if (stopReason === "toolUse") {
          // Mid-turn tool call — do NOT flush pending messages or broadcast
          // turn_end. The turn is still in progress.
          break;
        }

        // Flush deferred assistant messages: all but last are intermediate
        for (let i = 0; i < pendingAssistantMessages.length; i++) {
          const isLast = i === pendingAssistantMessages.length - 1;
          broadcast(
            wsHub,
            isLast
              ? { ...pendingAssistantMessages[i]!, source: "pi_outbound" }
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
