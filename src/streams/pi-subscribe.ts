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
  /** Pi SDK session ID — equals piSessionId in the database */
  sessionId: string;
  messages: Array<unknown>;
  subscribe: (listener: (event: PiSessionSubscriptionEvent) => void) => () => void;
  /**
   * SDK's SessionManager. Used to read the just-appended entry id at
   * `message_end` time (the SDK calls `appendMessage(event.message)`
   * synchronously *after* notifying our listener, so we defer the WS
   * broadcast via queueMicrotask and then read `getLeafId()` to obtain
   * the canonical, persistent id for the message).
   */
  sessionManager: { getLeafId: () => string | null };
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
type ExtractedToolCall = {
  toolUseId: string;
  toolName: string;
  args?: unknown;
  displayArgs?: unknown;
};

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
  toolDisplayCache: ToolDisplayContextCache,
  sessionStreamId?: string | null,
  sessionStreamName?: string | null,
  onAgentEnd?: (lastAssistantMessage: ChatTimelineMessage | null) => void,
): () => void {
  // Transient streaming-correlation key (T1). Lives only between an
  // assistant `message_start` and its `message_end`, used to tag the
  // `text_delta`/`thinking_delta` WS events so the streaming-store can
  // attribute them to the in-flight bubble. The SDK doesn't expose a
  // persistent id at message_start time — entry.id is only assigned later
  // when `appendMessage` runs (after `message_end`) — so we mint a local
  // counter-based key here. It never leaks into the canonical timeline
  // `id` field; that's the SDK's `entry.id` (T2 key), read via
  // `sessionManager.getLeafId()` after the entry has been appended.
  let streamingKeyCounter = session.messages.length;
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
          // Mint a transient streaming key for text_delta/thinking_delta
          // attribution. This is NOT the canonical message id — that's the
          // SDK's entry.id, only known once `appendMessage` has run after
          // `message_end`. Counter-based to keep WS payloads small; clients
          // treat it as opaque.
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

        // Capture stable references inside the case body — the broadcast
        // is deferred to a microtask so the SDK has a chance to call
        // `sessionManager.appendMessage(event.message)` (which it does
        // synchronously *after* notifying our listener). Once that runs,
        // `sessionManager.getLeafId()` returns the canonical entry.id, the
        // same id that's serialised to the JSONL session file and read back
        // on history reload — single persistent identity across live + disk.
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
        // Allow thinking-only messages (content empty but blocks non-empty) through.
        if (!role || (!content && blocks.length === 0)) break;

        const currentItem = role === "user" ? state.getSnapshot().currentItem : undefined;
        const capturedSource = currentItem?.source;
        const capturedStreamId = currentItem?.streamId ?? sessionStreamId ?? undefined;
        const capturedStreamName = currentItem?.streamName ?? sessionStreamName ?? undefined;
        const capturedServerMessageId = currentItem?.serverMessageId;
        const capturedClientMessageId = currentItem?.clientMessageId;
        const capturedHasThinking = blocks.some((b) => b.type === "thinking");
        const capturedBlocks = capturedHasThinking ? blocks : undefined;
        // Stamp displayArgs on each extracted tool call from the active
        // session formatter. O(1) per call on a warm cache; one SQL
        // lookup per pi-session lifetime (invalidated on worktree
        // mutation). The canonical `args` is untouched.
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
            // Broadcast immediately with intermediate flag so the session view gets it live.
            // The final correction (without intermediate) happens on agent_end.
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
              // Echo the originating client's optimistic-bubble id so the web
              // client can swap its optimistic entry for this canonical one.
              // Only present on user-role message_end; absent for WhatsApp/cron
              // origins that don't carry one.
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
        // NOTE: assistant messages are NOT surfaced here. runtime.ts broadcasts
        // stream_surfaced AFTER persistOutboundMessage so the serverMessageId is
        // set and the Surface timeline can dedup against DB records on refetch.
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
