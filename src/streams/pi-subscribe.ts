import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { touchPiEvent } from "../blackboard/pi-sessions.ts";
import type {
  ChatTimelineMessage,
  ChatTimelineMessageBlock,
  ImageAttachment,
} from "../contracts/index.ts";
import type { WebSocketHub } from "../ws/hub.ts";
import { ensureConversationMessageId, findConversationEntry } from "./conversation-identity.ts";
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

type ExtractedToolCall = {
  toolUseId: string;
  toolName: string;
  args?: unknown;
  displayArgs?: unknown;
};

export function extractMessageBlocks(message: unknown): {
  text: string | undefined;
  blocks: ChatTimelineMessageBlock[];
  images: ImageAttachment[];
  toolCalls: ExtractedToolCall[];
} {
  if (!message || typeof message !== "object")
    return { text: undefined, blocks: [], images: [], toolCalls: [] };

  const record = message as Record<string, unknown>;
  const content = record.content;

  if (Array.isArray(content)) {
    const blocks: ChatTimelineMessageBlock[] = [];
    const images: ImageAttachment[] = [];
    const toolCalls: ExtractedToolCall[] = [];
    let textBuffer = "";
    const flushTextBlock = () => {
      const text = textBuffer;
      textBuffer = "";
      if (text.trim()) blocks.push({ type: "text", text });
    };

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        textBuffer += item.text;
      } else if (
        item.type === "image" &&
        typeof item.data === "string" &&
        typeof item.mimeType === "string"
      ) {
        images.push({ data: item.data, mimeType: item.mimeType });
      } else if (item.type === "thinking" && typeof item.thinking === "string") {
        flushTextBlock();
        if (item.thinking.trim()) blocks.push({ type: "thinking", thinking: item.thinking });
      } else if (
        item.type === "toolCall" &&
        typeof item.id === "string" &&
        typeof item.name === "string"
      ) {
        flushTextBlock();
        blocks.push({ type: "tool", toolUseId: item.id });
        toolCalls.push({
          toolUseId: item.id,
          toolName: item.name,
          args: item.arguments as unknown,
        });
      }
    }

    flushTextBlock();
    const textBlocks = blocks.flatMap((block) => (block.type === "text" ? [block.text] : []));
    return {
      text: textBlocks.length ? textBlocks.join("\n\n") : undefined,
      blocks,
      images,
      toolCalls,
    };
  }

  const directText = [record.text, record.message].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return {
    text: directText,
    blocks: directText ? [{ type: "text", text: directText }] : [],
    images: [],
    toolCalls: [],
  };
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

        if (capturedRole === "toolResult") {
          if (!capturedMessageId) {
            reportMissingPersistedMessage(wsHub, session.sessionId, capturedMessageId);
            break;
          }
          const liveItem = toolResultMessageToTimelineItem(capturedMessage, capturedTimestamp);
          if (!liveItem) break;
          queueMicrotask(() => {
            const entry = findConversationEntry(session.sessionManager, capturedMessageId);
            if (!entry) {
              reportMissingPersistedMessage(wsHub, session.sessionId, capturedMessageId);
              return;
            }
            wsHub.broadcast({
              type: "tool_result",
              piSessionId: session.sessionId,
              item: { ...liveItem, piEntryId: entry.id },
            });
          });
          break;
        }

        const role =
          capturedRole === "user" || capturedRole === "assistant" ? capturedRole : undefined;
        if (!role) break;
        const { text: content, blocks, images, toolCalls } = extractMessageBlocks(capturedMessage);
        const currentItem = role === "user" ? state.takeUserMessageItem() : undefined;
        const capturedImages =
          images.length > 0
            ? images
            : (currentItem?.images?.map(({ data, mimeType }) => ({ data, mimeType })) ?? []);
        if (
          !content &&
          blocks.length === 0 &&
          capturedImages.length === 0 &&
          toolCalls.length === 0
        )
          break;

        const capturedSource = currentItem?.source;
        const capturedStreamId = currentItem?.streamId ?? sessionStreamId ?? undefined;
        const capturedStreamName = currentItem?.streamName ?? sessionStreamName ?? undefined;
        const capturedBlocks = blocks.length > 0 ? blocks : undefined;
        const enrichedToolCalls: ExtractedToolCall[] = toolCalls.map((tc) => {
          const display = toolDisplayCache.displayArgsForTool(
            session.sessionId,
            tc.toolName,
            tc.args,
          );
          return display ? { ...tc, displayArgs: display } : tc;
        });
        const capturedToolCalls = enrichedToolCalls.length > 0 ? enrichedToolCalls : undefined;

        if (!capturedMessageId) {
          reportMissingPersistedMessage(wsHub, session.sessionId, capturedMessageId);
          break;
        }

        const timelineMessage: ChatTimelineMessage = {
          id: capturedMessageId,
          kind: "message",
          role,
          content: content ?? "",
          source: capturedSource,
          streamId: capturedStreamId,
          streamName: capturedStreamName,
          createdAt: capturedTimestamp,
        };
        if (capturedBlocks) timelineMessage.blocks = capturedBlocks;
        if (capturedImages.length > 0) timelineMessage.images = capturedImages;
        if (role === "assistant") {
          const usage = parseUsage((capturedMessage as { usage?: unknown }).usage);
          if (usage) timelineMessage.usage = usage;
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
          wsHub.broadcast({
            type: "message_end",
            piSessionId: session.sessionId,
            message: {
              ...timelineMessage,
              piEntryId: entry.id,
              ...(role === "assistant" ? { intermediate: true } : {}),
            },
            ...(capturedToolCalls ? { toolCalls: capturedToolCalls } : {}),
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
