import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessageRow } from "../src/components/chat-message-row.tsx";
import { ToolMessage } from "../src/components/chat-tool-message.tsx";
import { CodeBlock } from "../src/components/common/code-block.tsx";
import { MarkdownContent } from "../src/components/common/markdown-content.tsx";
import { conversationState } from "../src/lib/conversation-state.ts";
import type { ConversationRow } from "../src/lib/conversation-rows.ts";
import type { ChatTimelineTool } from "../src/lib/types.ts";

const createdAt = "2026-08-05T00:00:00.000Z";

function toolStart(id: string, tool = "bash"): ChatTimelineTool {
  return {
    id: `tool-${id}-start`,
    kind: "tool",
    tool,
    phase: "start",
    toolUseId: id,
    args: { command: "pwd" },
    createdAt,
  };
}

test("renders mixed assistant blocks in canonical thinking, text, tool, text order", () => {
  const start = toolStart("call-1");
  const row: ConversationRow = {
    key: "row:assistant",
    message: {
      id: "assistant",
      kind: "message",
      role: "assistant",
      content: "before\nafter",
      blocks: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "before" },
        { type: "tool", toolUseId: "call-1" },
        { type: "text", text: "after" },
      ],
      createdAt,
    },
    tools: [
      {
        start,
        end: { ...start, id: "tool-call-1-end", phase: "end", result: "ok" },
      },
    ],
  };

  const html = renderToStaticMarkup(
    <ChatMessageRow row={row} piSessionId="render-order-session" />,
  );

  const thinking = html.indexOf("Thinking");
  const before = html.indexOf("before");
  const tool = html.indexOf("pwd");
  const after = html.indexOf("after");
  assert.ok(thinking >= 0 && thinking < before);
  assert.ok(before < tool);
  assert.ok(tool < after);
});

test("escapes raw HTML, rejects unsafe URLs, and keeps external links isolated", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      content={'<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n[external](https://example.com)\n\n![bad](//example.com/x.png)'}
    />,
  );

  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("//example.com/x.png"));
  assert.match(
    html,
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">external<\/a>/,
  );
});

test("namespaces footnotes per message and keeps their navigation in-page", () => {
  const html = renderToStaticMarkup(
    <div>
      <MarkdownContent content={"First[^1]\n\n[^1]: one"} />
      <MarkdownContent content={"Second[^1]\n\n[^1]: two"} />
    </div>,
  );
  const ids = Array.from(
    html.matchAll(/id="(markdown-[^"]+-user-content-fn-1)"/g),
    (match) => match[1],
  );

  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) {
    assert.ok(html.includes(`href="#${id}"`));
  }
  const footnoteLinks = html.match(/<a[^>]+data-footnote-(?:ref|backref)[^>]*>/g) ?? [];
  assert.ok(footnoteLinks.length >= 4);
  assert.ok(footnoteLinks.every((anchor) => !anchor.includes("target=")));
});

test("skips highlighting while a fence streams and highlights it after commit", () => {
  const content = `${"`".repeat(3)}ts\nconst answer = true`;
  const streaming = renderToStaticMarkup(<MarkdownContent content={content} streaming />);
  const committed = renderToStaticMarkup(<MarkdownContent content={`${content}\n${"`".repeat(3)}`} />);

  assert.ok(!streaming.includes("hljs-keyword"));
  assert.ok(committed.includes("hljs-keyword"));
});

test("does not auto-highlight plain, unknown, or oversized code", () => {
  const plain = renderToStaticMarkup(<CodeBlock code="const answer = true" language="plaintext" />);
  const unknown = renderToStaticMarkup(<CodeBlock code="const answer = true" language="custom" />);
  const oversized = renderToStaticMarkup(
    <CodeBlock code={`const answer = true\n${"x".repeat(50_000)}`} language="typescript" />,
  );

  assert.ok(!plain.includes("hljs-keyword"));
  assert.ok(!unknown.includes("hljs-keyword"));
  assert.ok(!oversized.includes("hljs-keyword"));
});

test("renders active partial and error tool state from its keyed snapshot", () => {
  const sessionId = "render-active-tool";
  conversationState.tool(sessionId, {
    toolUseId: "call-1",
    pending: false,
    partialResult: "failed output",
    isError: true,
  });

  try {
    const html = renderToStaticMarkup(
      <ToolMessage item={toolStart("call-1", "custom")} piSessionId={sessionId} />,
    );
    assert.ok(html.includes("Tool failed"));
    assert.ok(html.includes("failed output"));
  } finally {
    conversationState.clear(sessionId);
  }
});
