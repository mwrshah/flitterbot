import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdown, renderHtml } from "@tanstack/markdown";
import { streamingMarkdownExtension } from "@tanstack/markdown/extensions/streaming";
import { namespacedFootnoteId, safeMarkdownUrl } from "../src/lib/markdown.ts";

test("accepts only the Markdown URL policy", () => {
  assert.equal(safeMarkdownUrl("#footnote"), "#footnote");
  assert.equal(safeMarkdownUrl("/docs/readme"), "/docs/readme");
  assert.equal(safeMarkdownUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(safeMarkdownUrl("mailto:user@example.com"), "mailto:user@example.com");
  assert.equal(safeMarkdownUrl("tel:+123456"), "tel:+123456");

  assert.equal(safeMarkdownUrl("//example.com/path"), null);
  assert.equal(safeMarkdownUrl("docs/readme.md"), null);
  assert.equal(safeMarkdownUrl("javascript:alert(1)"), null);
  assert.equal(safeMarkdownUrl("data:text/html,unsafe"), null);
  assert.equal(safeMarkdownUrl(""), null);
});

test("escapes raw HTML and completes an unfinished streaming fence", () => {
  assert.equal(
    renderHtml("<script>alert(1)</script>", { allowHtml: false }),
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
  );
  const fence = `${"`".repeat(3)}ts\nconst x = 1`;
  const document = parseMarkdown(fence, { extensions: [streamingMarkdownExtension()] });
  assert.deepEqual(document.children, [{ type: "code", value: "const x = 1", lang: "ts" }]);
});

test("namespaces generated footnote ids without changing ordinary ids", () => {
  assert.equal(
    namespacedFootnoteId("user-content-fn-1", "markdown-r1"),
    "markdown-r1-user-content-fn-1",
  );
  assert.equal(
    namespacedFootnoteId("user-content-fnref-1", "markdown-r1"),
    "markdown-r1-user-content-fnref-1",
  );
  assert.equal(
    namespacedFootnoteId("footnote-label", "markdown-r1"),
    "markdown-r1-footnote-label",
  );
  assert.equal(namespacedFootnoteId("custom-heading", "markdown-r1"), "custom-heading");
});
