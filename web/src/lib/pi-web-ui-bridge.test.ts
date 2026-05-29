import { describe, expect, test } from "bun:test";
import type { ChatTimelineItem } from "../../../src/contracts/index.ts";
import { type RenderableToolCall, timelineToAgentMessages } from "./pi-web-ui-bridge.ts";

describe("timelineToAgentMessages — display args", () => {
  test("renderable tool call exposes displayArguments alongside canonical arguments", () => {
    const timeline: ChatTimelineItem[] = [
      {
        id: "m1",
        kind: "message",
        role: "assistant",
        content: "calling read",
        createdAt: "2026-05-25T00:00:00.000Z",
      },
      {
        id: "t1",
        kind: "tool",
        tool: "read",
        phase: "start",
        toolUseId: "u1",
        args: { path: "/repo-worktrees/x/src/a.ts" },
        displayArgs: { path: "src/a.ts" },
        createdAt: "2026-05-25T00:00:00.000Z",
      },
    ];

    const out = timelineToAgentMessages(timeline);
    expect(out).toHaveLength(1);
    const assistant = out[0] as { role: string; content: unknown[] };
    expect(assistant.role).toBe("assistant");
    const toolCall = assistant.content[assistant.content.length - 1] as RenderableToolCall;
    expect(toolCall.type).toBe("toolCall");
    expect(toolCall.arguments).toEqual({ path: "/repo-worktrees/x/src/a.ts" });
    expect(toolCall.displayArguments).toEqual({ path: "src/a.ts" });
  });

  test("missing displayArgs leaves displayArguments undefined", () => {
    const timeline: ChatTimelineItem[] = [
      {
        id: "m1",
        kind: "message",
        role: "assistant",
        content: "calling read",
        createdAt: "2026-05-25T00:00:00.000Z",
      },
      {
        id: "t1",
        kind: "tool",
        tool: "read",
        phase: "start",
        toolUseId: "u1",
        args: { path: "relative/x.ts" },
        createdAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const out = timelineToAgentMessages(timeline);
    const assistant = out[0] as { content: unknown[] };
    const toolCall = assistant.content[assistant.content.length - 1] as RenderableToolCall;
    expect(toolCall.arguments).toEqual({ path: "relative/x.ts" });
    expect(toolCall.displayArguments).toBeUndefined();
  });

  test("orphan tool item also carries displayArguments", () => {
    const timeline: ChatTimelineItem[] = [
      {
        id: "t1",
        kind: "tool",
        tool: "read",
        phase: "start",
        toolUseId: "u1",
        args: { path: "/worktree/src/a.ts" },
        displayArgs: { path: "src/a.ts" },
        createdAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const out = timelineToAgentMessages(timeline);
    expect(out).toHaveLength(1);
    const assistant = out[0] as { content: unknown[] };
    const toolCall = assistant.content[0] as RenderableToolCall;
    expect(toolCall.arguments).toEqual({ path: "/worktree/src/a.ts" });
    expect(toolCall.displayArguments).toEqual({ path: "src/a.ts" });
  });
});
