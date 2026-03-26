/**
 * Bridge between the ChatPanel timeline model and the pi-web-ui Lit
 * components that expect AgentMessage[] format.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import type { StreamingToolCall } from "./pi-session-store";
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
 * Cache for timelineToAgentMessages: keyed on the first ChatTimelineItem in
 * each logical group, stores { groupSize, message } so we can return a stable
 * AgentMessage ref when the group hasn't changed.
 */
const agentMessageCache = new WeakMap<
  ChatTimelineItem,
  { groupSize: number; message: AgentMessage }
>();

/**
 * Convert our ChatTimelineItem[] into the AgentMessage[] shape that
 * pi-web-ui's <message-list> web component expects.
 *
 * Processes timeline strictly in chronological order so tool calls
 * appear inline where they occurred, not dumped at the end.
 *
 * Uses a WeakMap cache keyed on the leading ChatTimelineItem ref of each
 * group so that unchanged items return the same AgentMessage object.
 * mergeTimelines preserves individual item refs, so cache hits work for
 * all items that haven't changed.
 */
export function timelineToAgentMessages(timeline: ChatTimelineItem[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const consumed = new Set<number>(); // indices consumed by look-ahead

  for (let i = 0; i < timeline.length; i++) {
    if (consumed.has(i)) continue;
    const item = timeline[i];
    if (!item) continue;

    if (item.kind === "divider") continue;

    if (item.kind === "message" && item.role === "user") {
      // User messages are always a group of 1
      const cached = agentMessageCache.get(item);
      if (cached && cached.groupSize === 1) {
        messages.push(cached.message);
        continue;
      }
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
      const msg = {
        role: "user",
        content,
        timestamp: new Date(item.createdAt).getTime(),
        source,
      } as AgentMessage & { source: MessageSource };
      agentMessageCache.set(item, { groupSize: 1, message: msg });
      messages.push(msg);
      continue;
    }

    if (item.kind === "message" && item.role === "assistant") {
      const message = item as ChatTimelineMessage;
      // Look ahead for immediately following tool starts (before next message/divider)
      let groupSize = 1;
      const toolIndices: number[] = [];
      for (let j = i + 1; j < timeline.length; j++) {
        const next = timeline[j];
        if (!next) break;
        if (next.kind === "message" || next.kind === "divider") break;
        if (next.kind === "tool" && next.phase === "start" && next.toolUseId) {
          toolIndices.push(j);
          groupSize++;
        }
      }

      // Check cache: same lead item ref AND same group size
      const cached = agentMessageCache.get(item);
      if (cached && cached.groupSize === groupSize) {
        for (const j of toolIndices) consumed.add(j);
        messages.push(cached.message);
        continue;
      }

      const toolCalls: ToolCall[] = [];
      for (const j of toolIndices) {
        const next = timeline[j]!;
        if (next.kind === "tool" && next.phase === "start" && next.toolUseId) {
          toolCalls.push({
            type: "toolCall",
            id: next.toolUseId,
            name: next.tool,
            arguments: (next.args as Record<string, unknown>) ?? {},
          });
        }
        consumed.add(j);
      }

      const content: AssistantMessage["content"] = assistantBlocksToContent(message);
      content.push(...toolCalls);

      const msg = {
        role: "assistant",
        content,
        stopReason: "endTurn",
        timestamp: new Date(item.createdAt).getTime(),
      } as unknown as AgentMessage;
      agentMessageCache.set(item, { groupSize, message: msg });
      messages.push(msg);
      continue;
    }

    if (item.kind === "tool" && item.phase === "start" && item.toolUseId) {
      // Orphan tool start (no preceding assistant message) — emit in place
      const cached = agentMessageCache.get(item);
      if (cached && cached.groupSize === 1) {
        messages.push(cached.message);
        continue;
      }
      const msg = {
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
      } as unknown as AgentMessage;
      agentMessageCache.set(item, { groupSize: 1, message: msg });
      messages.push(msg);
      continue;
    }

    if (item.kind === "tool" && item.phase === "end" && item.toolUseId) {
      // Emit ToolResultMessage in place
      const cached = agentMessageCache.get(item);
      if (cached && cached.groupSize === 1) {
        messages.push(cached.message);
        continue;
      }
      const msg = {
        role: "toolResult",
        toolCallId: item.toolUseId,
        toolName: item.tool,
        content: [{ type: "text", text: stringifyResult(item.result) }],
        isError: item.isError ?? false,
        timestamp: new Date(item.createdAt).getTime(),
      } as unknown as AgentMessage;
      agentMessageCache.set(item, { groupSize: 1, message: msg });
      messages.push(msg);
    }
  }

  return messages;
}

/**
 * Build a streaming AssistantMessage from partial text for the
 * <assistant-message> web component.
 */
export function buildStreamingAssistantMessage(
  text: string,
  thinking?: string,
  toolCalls?: StreamingToolCall[],
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (thinking) content.push({ type: "thinking", thinking } as ThinkingContent);
  if (text) content.push({ type: "text", text });
  if (toolCalls?.length) {
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.partialJson);
      } catch {
        // Partial JSON — pass empty args, the component handles it
      }
      content.push({
        type: "toolCall",
        id: `streaming-tc-${tc.contentIndex}`,
        name: tc.toolName,
        arguments: args,
      } as ToolCall);
    }
  }
  return {
    role: "assistant",
    content,
    stopReason: null,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}
