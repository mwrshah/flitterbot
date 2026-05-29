import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";

export type RenderableToolCall = ToolCall & {
  displayArguments?: Record<string, unknown>;
};

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
        _entryId: item.id,
      } as AgentMessage & { source: MessageSource; _entryId?: string });
      continue;
    }

    if (item.kind === "message" && item.role === "assistant") {
      const message = item as ChatTimelineMessage;
      const toolCalls: RenderableToolCall[] = [];
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
            ...(next.displayArgs !== undefined
              ? { displayArguments: next.displayArgs as Record<string, unknown> }
              : {}),
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
      const orphanCall: RenderableToolCall = {
        type: "toolCall",
        id: item.toolUseId,
        name: item.tool,
        arguments: (item.args as Record<string, unknown>) ?? {},
        ...(item.displayArgs !== undefined
          ? { displayArguments: item.displayArgs as Record<string, unknown> }
          : {}),
      };
      messages.push({
        role: "assistant",
        content: [orphanCall],
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

export function timelineItemsToAgentMessages(items: ChatTimelineItem[]): AgentMessage[] {
  return timelineToAgentMessages(items);
}
