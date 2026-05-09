/**
 * Bridge between the ChatPanel timeline model and the pi-web-ui Lit
 * components that expect AgentMessage[] format.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ImageAttachment,
  MessageSource,
} from "./types";

function stringifyResult(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function assistantBlocksToContent(message: ChatTimelineMessage): AssistantMessage["content"] {
  if (!message.blocks?.length) {
    return message.content.trim() ? [{ type: "text", text: message.content }] : [];
  }

  return message.blocks.flatMap((block): Array<TextContent | ThinkingContent> => {
    if (block.type === "text") {
      return block.text.trim() ? [{ type: "text", text: block.text }] : [];
    }
    return block.thinking.trim() ? [{ type: "thinking", thinking: block.thinking }] : [];
  });
}

/**
 * Convert our ChatTimelineItem[] into the AgentMessage[] shape that
 * pi-web-ui's <message-list> web component expects.
 *
 * Ordering: toolcall_start is now buffered in the streaming store until
 * message_end, so tool items always arrive in the Query cache *after* the
 * assistant message. The forward look-ahead finds them correctly.
 *
 * phase "update": tool_execution_update transitions "start" → "update" in-place.
 * Both phases carry the same toolUseId/name/args so the look-ahead treats them
 * identically — the tool call block stays visible throughout execution.
 */
export function timelineToAgentMessages(timeline: ChatTimelineItem[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < timeline.length; i++) {
    if (consumed.has(i)) continue;
    const item = timeline[i];
    if (!item) continue;

    if (item.kind === "divider") continue;

    if (item.kind === "message" && item.role === "user") {
      const source = item.source ?? "web";
      const images = item.images;
      let content: string | (TextContent | ImageContent)[] = item.content;
      if (images?.length) {
        content = [
          { type: "text", text: item.content },
          ...images.map((img: ImageAttachment) => ({
            type: "image" as const,
            data: img.data,
            mimeType: img.mimeType,
          })),
        ];
      }
      messages.push({
        role: "user",
        content,
        timestamp: new Date(item.createdAt).getTime(),
        source,
        // Non-standard passthrough: ChatTimelineMessage.id IS the SDK
        // SessionManager entry id (post-message_end), so it can be passed
        // straight through as the prune target. The <user-message> Lit
        // component reads `_entryId` to expose the "delete from here" menu.
        _entryId: item.id,
      } as AgentMessage & { source: MessageSource; _entryId?: string });
      continue;
    }

    if (item.kind === "message" && item.role === "assistant") {
      const message = item as ChatTimelineMessage;
      const toolCalls: ToolCall[] = [];
      for (let j = i + 1; j < timeline.length; j++) {
        const next = timeline[j];
        if (!next) break;
        if (next.kind === "message" || next.kind === "divider") break;
        if (
          next.kind === "tool" &&
          (next.phase === "start" || next.phase === "update") &&
          next.toolUseId
        ) {
          toolCalls.push({
            type: "toolCall",
            id: next.toolUseId,
            name: next.tool,
            arguments: (next.args as Record<string, unknown>) ?? {},
          });
          consumed.add(j);
        }
      }

      const content: AssistantMessage["content"] = assistantBlocksToContent(message);
      content.push(...toolCalls);

      messages.push({
        role: "assistant",
        content,
        stopReason: "endTurn",
        timestamp: new Date(item.createdAt).getTime(),
      } as unknown as AgentMessage);
      continue;
    }

    if (
      item.kind === "tool" &&
      (item.phase === "start" || item.phase === "update") &&
      item.toolUseId
    ) {
      // Orphan tool — no preceding assistant message (e.g. after reconnect).
      messages.push({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: item.toolUseId,
            name: item.tool,
            arguments: (item.args as Record<string, unknown>) ?? {},
          },
        ],
        stopReason: "endTurn",
        timestamp: new Date(item.createdAt).getTime(),
      } as unknown as AgentMessage);
      continue;
    }

    if (item.kind === "tool" && item.phase === "end" && item.toolUseId) {
      messages.push({
        role: "toolResult",
        toolCallId: item.toolUseId,
        toolName: item.tool,
        content: [{ type: "text", text: stringifyResult(item.result) }],
        isError: item.isError ?? false,
        timestamp: new Date(item.createdAt).getTime(),
      } as unknown as AgentMessage);
    }
  }

  return messages;
}

/**
 * Convert a small set of timeline items (e.g. one message + its tool calls
 * from message_end) into AgentMessage[] format. Same logic as
 * timelineToAgentMessages but semantically named for the imperative commit path.
 */
export function timelineItemsToAgentMessages(items: ChatTimelineItem[]): AgentMessage[] {
  return timelineToAgentMessages(items);
}

/**
 * Derive the set of toolUseIds that have started but not yet ended.
 */
export function pendingToolCallsFromTimeline(timeline: ChatTimelineItem[]): Set<string> {
  const started = new Set<string>();
  const ended = new Set<string>();
  for (const item of timeline) {
    if (item.kind === "tool" && item.toolUseId) {
      if (item.phase === "start") started.add(item.toolUseId);
      else ended.add(item.toolUseId);
    }
  }
  for (const id of ended) started.delete(id);
  return started;
}
