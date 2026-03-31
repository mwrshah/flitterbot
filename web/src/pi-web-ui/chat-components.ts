import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage as AssistantMessageType,
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage as ToolResultMessageType,
  Usage,
  UserMessage as UserMessageType,
} from "@mariozechner/pi-ai";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import htmlLanguage from "highlight.js/lib/languages/xml";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import createElement from "lucide/dist/esm/createElement.js";
import Check from "lucide/dist/esm/icons/check.js";
import ChevronRight from "lucide/dist/esm/icons/chevron-right.js";
import Code from "lucide/dist/esm/icons/code.js";
import Copy from "lucide/dist/esm/icons/copy.js";
import FilePen from "lucide/dist/esm/icons/file-pen.js";
import FileText from "lucide/dist/esm/icons/file-text.js";
import FolderOpen from "lucide/dist/esm/icons/folder-open.js";
import MessageSquare from "lucide/dist/esm/icons/message-square.js";
import Search from "lucide/dist/esm/icons/search.js";
import SquareTerminal from "lucide/dist/esm/icons/square-terminal.js";
import { marked } from "marked";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("html", htmlLanguage);
hljs.registerLanguage("xml", htmlLanguage);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);

type UserMessageWithAttachments = {
  role: "user-with-attachments";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
  attachments?: unknown[];
};

type RenderMessage = AgentMessage | UserMessageWithAttachments | { role: "artifact" };

function i18n(text: string): string {
  return text;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

function formatUsage(usage?: Usage): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.input) parts.push(`↑${formatTokenCount(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokenCount(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokenCount(usage.cacheWrite)}`);
  if (usage.cost?.total) parts.push(formatCost(usage.cost.total));
  return parts.join(" ");
}

function iconSvg(iconNode: unknown, size: "sm" | "md" = "md", className = ""): string {
  const classes = size === "sm" ? "w-4 h-4" : "w-5 h-5";
  const el = createElement(iconNode as Parameters<typeof createElement>[0], {
    class: `${classes}${className ? ` ${className}` : ""}`,
  });
  return el.outerHTML;
}

function encodeUtf8Base64(value: string): string {
  return btoa(unescape(encodeURIComponent(value)));
}

function decodeUtf8Base64(value: string): string {
  try {
    return decodeURIComponent(escape(atob(value)));
  } catch {
    return value;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

function prettyValue(value: unknown): { content: string; language: string } {
  if (typeof value === "string") {
    try {
      return { content: JSON.stringify(JSON.parse(value), null, 2), language: "json" };
    } catch {
      return { content: value, language: "text" };
    }
  }

  if (value == null) {
    return { content: "", language: "text" };
  }

  try {
    return { content: JSON.stringify(value, null, 2), language: "json" };
  } catch {
    return { content: String(value), language: "text" };
  }
}

export class MessageCopyButton extends LitElement {
  @property() text = "";
  @state() private copied = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.text);
      this.copied = true;
      setTimeout(() => {
        this.copied = false;
      }, 1500);
    } catch (error) {
      console.error("Failed to copy message", error);
    }
  }

  override render() {
    if (!this.text) return nothing;
    return html`
      <button
        @click=${this.copy}
        class="absolute bottom-1.5 right-1.5 p-1 rounded text-muted-foreground/40 hover:text-muted-foreground opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
        title="${i18n("Copy message")}"
      >
        ${unsafeHTML(iconSvg(this.copied ? Check : Copy, "sm"))}
      </button>
    `;
  }
}

if (!customElements.get("message-copy-button")) {
  customElements.define("message-copy-button", MessageCopyButton);
}

export class MarkdownBlock extends LitElement {
  @property() content = "";
  @property({ type: Boolean }) isThinking = false;
  @property({ type: Boolean }) escapeHtml = true;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.classList.add("markdown-content");
    this.style.display = "block";
  }

  override render() {
    if (!this.content) return html``;

    const renderer = new marked.Renderer();
    const originalLink = renderer.link;
    renderer.link = function (...args: Parameters<typeof originalLink>) {
      const link = originalLink.apply(this, args);
      return link.replace("<a ", '<a target="_blank" rel="noopener noreferrer" ');
    };

    const parsed = marked.parse(this.content, { async: false, renderer }) as string;

    const withCodeBlocks = parsed
      .replace(
        /<pre><code class="language-([^"]+)">([\s\S]+?)<\/code><\/pre>/g,
        (_m, language, code) => {
          const decoded = decodeHtmlEntities(code);
          return `<code-block code="${encodeUtf8Base64(decoded)}" language="${language}"></code-block>`;
        },
      )
      .replace(/<pre><code>([\s\S]+?)<\/code><\/pre>/g, (_m, code) => {
        const decoded = decodeHtmlEntities(code);
        return `<code-block code="${encodeUtf8Base64(decoded)}" language="text"></code-block>`;
      });

    return html`${unsafeHTML(withCodeBlocks)}`;
  }
}

if (!customElements.get("markdown-block")) {
  customElements.define("markdown-block", MarkdownBlock);
}

export class CodeBlock extends LitElement {
  @property() code = "";
  @property() language = "";
  @state() private copied = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "block";
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(decodeUtf8Base64(this.code));
      this.copied = true;
      setTimeout(() => {
        this.copied = false;
      }, 1500);
    } catch (error) {
      console.error("Failed to copy code", error);
    }
  }

  override render() {
    const decodedCode = decodeUtf8Base64(this.code);
    const highlighted =
      this.language && hljs.getLanguage(this.language)
        ? hljs.highlight(decodedCode, { language: this.language }).value
        : hljs.highlightAuto(decodedCode).value;
    const displayLanguage = this.language || "plaintext";

    return html`
      <div class="border border-border rounded-lg overflow-hidden">
        <div class="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border">
          <span class="text-xs text-muted-foreground font-mono">${displayLanguage}</span>
          <button
            @click=${this.copy}
            class="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title="${i18n("Copy code")}"
          >
            ${unsafeHTML(iconSvg(this.copied ? Check : Copy, "sm"))}
            ${this.copied ? html`<span>${i18n("Copied!")}</span>` : ""}
          </button>
        </div>
        <div class="overflow-auto max-h-96">
          <pre class="!bg-transparent !border-0 !rounded-none m-0 px-4 pb-4 pt-3 text-xs text-foreground font-mono"><code class="hljs language-${displayLanguage}">${unsafeHTML(highlighted)}</code></pre>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("code-block")) {
  customElements.define("code-block", CodeBlock);
}

export class ConsoleBlock extends LitElement {
  @property() content = "";
  @property() variant: "default" | "error" = "default";
  @state() private copied = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "block";
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.content || "");
      this.copied = true;
      setTimeout(() => {
        this.copied = false;
      }, 1500);
    } catch (error) {
      console.error("Copy failed", error);
    }
  }

  override updated(): void {
    const container = this.querySelector(".console-scroll") as HTMLElement | null;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  override render() {
    const textClass = this.variant === "error" ? "text-destructive" : "text-foreground";

    return html`
      <div class="border border-border rounded-lg overflow-hidden">
        <div class="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border">
          <span class="text-xs text-muted-foreground font-mono">${i18n("console")}</span>
          <button
            @click=${this.copy}
            class="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title="${i18n("Copy output")}"
          >
            ${unsafeHTML(iconSvg(this.copied ? Check : Copy, "sm"))}
            ${this.copied ? html`<span>${i18n("Copied!")}</span>` : ""}
          </button>
        </div>
        <div class="console-scroll overflow-auto max-h-64">
          <pre class="!bg-background !border-0 !rounded-none m-0 p-3 text-xs ${textClass} font-mono whitespace-pre-wrap">${this.content || ""}</pre>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("console-block")) {
  customElements.define("console-block", ConsoleBlock);
}

export class ThinkingBlock extends LitElement {
  @property() content = "";
  @property({ type: Boolean }) isStreaming = false;
  @state() private isExpanded = true;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "block";
  }

  private toggleExpanded = (): void => {
    this.isExpanded = !this.isExpanded;
  };

  override render() {
    const isOpen = this.isExpanded;
    const shimmerClasses = this.isStreaming
      ? "animate-shimmer bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground bg-[length:200%_100%] bg-clip-text text-transparent"
      : "";

    return html`
      <div class="thinking-block">
        <button
          type="button"
          class="thinking-header flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-expanded=${String(isOpen)}
          @click=${this.toggleExpanded}
        >
          <span class="flex min-w-0 items-center gap-2">
            <span class="inline-block h-2 w-2 rounded-full bg-muted-foreground/45" aria-hidden="true"></span>
            <span class="${shimmerClasses}">${i18n("Thinking…")}</span>
          </span>
          <span class="shrink-0 text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70">
            ${isOpen ? i18n("Hide") : i18n("Show")}
          </span>
        </button>
        ${
          isOpen
            ? html`<div class="pl-4 pt-1"><markdown-block .content=${this.content} .isThinking=${true}></markdown-block></div>`
            : ""
        }
      </div>
    `;
  }
}

if (!customElements.get("thinking-block")) {
  customElements.define("thinking-block", ThinkingBlock);
}

function renderToolHeader(iconNode: unknown, text: string): TemplateResult {
  return html`
    <div class="flex items-center gap-2 text-sm text-muted-foreground">
      <span class="inline-block text-foreground">${unsafeHTML(iconSvg(iconNode, "sm"))}</span>
      <span>${text}</span>
    </div>
  `;
}

function renderDefaultTool(
  params: unknown,
  result: ToolResultMessageType | undefined,
  isStreaming?: boolean,
): TemplateResult {
  const stateText = result
    ? result.isError
      ? i18n("Tool failed")
      : i18n("Tool Call")
    : isStreaming
      ? i18n("Preparing tool...")
      : i18n("Tool Call");

  const prettyParams = prettyValue(params);
  const textOutput =
    result?.content
      ?.filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n") || i18n("(no output)");
  const prettyOutput = prettyValue(textOutput);

  return html`
    <div class="space-y-3">
      ${renderToolHeader(Code, stateText)}
      ${
        prettyParams.content
          ? html`
            <div>
              <div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Input")}</div>
              <code-block .code=${encodeUtf8Base64(prettyParams.content)} language=${prettyParams.language}></code-block>
            </div>
          `
          : ""
      }
      ${
        result
          ? html`
            <div>
              <div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Output")}</div>
              <code-block .code=${encodeUtf8Base64(prettyOutput.content)} language=${prettyOutput.language}></code-block>
            </div>
          `
          : ""
      }
    </div>
  `;
}

function renderBashTool(
  params: unknown,
  result: ToolResultMessageType | undefined,
): TemplateResult {
  const command =
    typeof params === "object" && params && "command" in (params as Record<string, unknown>)
      ? String((params as Record<string, unknown>).command ?? "")
      : "";

  const output =
    result?.content
      ?.filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n") || "";

  const combined = command ? `> ${command}${output ? `\n\n${output}` : ""}` : output;

  return html`
    <div class="space-y-3">
      ${renderToolHeader(SquareTerminal, command ? i18n("Running command...") : i18n("Waiting for command..."))}
      <console-block .content=${combined} .variant=${result?.isError ? "error" : "default"}></console-block>
    </div>
  `;
}

function paramRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params ? (params as Record<string, unknown>) : {};
}

function resultText(result: ToolResultMessageType | undefined): string {
  return (
    result?.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n") || ""
  );
}

function truncateLines(text: string, max: number): { lines: string; truncated: boolean } {
  const all = text.split("\n");
  if (all.length <= max) return { lines: text, truncated: false };
  return { lines: all.slice(0, max).join("\n"), truncated: true };
}

function renderEditTool(
  params: unknown,
  result: ToolResultMessageType | undefined,
): TemplateResult {
  const p = paramRecord(params);
  const filePath = String(p.file_path ?? p.filePath ?? "");

  const oldStr = String(p.old_string ?? p.oldString ?? "");
  const newStr = String(p.new_string ?? p.newString ?? "");

  const diffLines: string[] = [];
  if (oldStr) for (const l of oldStr.split("\n")) diffLines.push(`- ${l}`);
  if (newStr) for (const l of newStr.split("\n")) diffLines.push(`+ ${l}`);

  return html`
    <div class="space-y-2">
      ${renderToolHeader(FilePen, `Editing ${filePath}`)}
      ${
        diffLines.length
          ? html`<pre class="text-xs font-mono rounded-md border border-border p-2 overflow-auto max-h-64 whitespace-pre-wrap">${diffLines.map(
              (l) =>
                l.startsWith("- ")
                  ? html`<span class="text-red-400">${l}\n</span>`
                  : l.startsWith("+ ")
                    ? html`<span class="text-green-400">${l}\n</span>`
                    : html`${l}\n`,
            )}</pre>`
          : ""
      }
      ${result?.isError ? html`<div class="text-xs text-destructive">${resultText(result)}</div>` : ""}
    </div>
  `;
}

function renderWriteTool(
  params: unknown,
  result: ToolResultMessageType | undefined,
): TemplateResult {
  const p = paramRecord(params);
  const filePath = String(p.file_path ?? p.filePath ?? "");
  const content = String(p.content ?? "");
  const { lines, truncated } = truncateLines(content, 10);

  return html`
    <div class="space-y-2">
      ${renderToolHeader(FileText, `Writing ${filePath}`)}
      <pre class="text-xs font-mono rounded-md border border-border p-2 overflow-auto max-h-64 whitespace-pre-wrap">${lines}${truncated ? html`\n<span class="text-muted-foreground">… truncated</span>` : ""}</pre>
      ${result?.isError ? html`<div class="text-xs text-destructive">${resultText(result)}</div>` : ""}
    </div>
  `;
}

function renderReadTool(
  params: unknown,
  result: ToolResultMessageType | undefined,
): TemplateResult {
  const p = paramRecord(params);
  const filePath = String(p.file_path ?? p.filePath ?? "");
  const output = resultText(result);
  const { lines, truncated } = truncateLines(output, 10);

  return html`
    <div class="space-y-2">
      ${renderToolHeader(FileText, `Reading ${filePath}`)}
      ${
        output
          ? html`<pre class="text-xs font-mono rounded-md border border-border p-2 overflow-auto max-h-64 whitespace-pre-wrap">${lines}${truncated ? html`\n<span class="text-muted-foreground">… truncated</span>` : ""}</pre>`
          : ""
      }
      ${result?.isError ? html`<div class="text-xs text-destructive">${output}</div>` : ""}
    </div>
  `;
}

function renderGrepTool(
  params: unknown,
  result: ToolResultMessageType | undefined,
): TemplateResult {
  const p = paramRecord(params);
  const pattern = String(p.pattern ?? "");
  const path = String(p.path ?? ".");
  const output = resultText(result);

  return html`
    <div class="space-y-2">
      ${renderToolHeader(Search, `grep ${pattern} ${path}`)}
      ${
        output
          ? html`<pre class="text-xs font-mono rounded-md border border-border p-2 overflow-auto max-h-64 whitespace-pre-wrap">${output}</pre>`
          : ""
      }
      ${result?.isError ? html`<div class="text-xs text-destructive">${output}</div>` : ""}
    </div>
  `;
}

function renderLsTool(params: unknown, result: ToolResultMessageType | undefined): TemplateResult {
  const p = paramRecord(params);
  const path = String(p.path ?? p.directory ?? ".");
  const output = resultText(result);

  return html`
    <div class="space-y-2">
      ${renderToolHeader(FolderOpen, `ls ${path}`)}
      ${
        output
          ? html`<pre class="text-xs font-mono rounded-md border border-border p-2 overflow-auto max-h-64 whitespace-pre-wrap">${output}</pre>`
          : ""
      }
    </div>
  `;
}

function renderSendToUserTool(
  params: unknown,
  result: ToolResultMessageType | undefined,
): TemplateResult {
  const p = paramRecord(params);
  const text = String(p.text ?? p.message ?? "");

  return html`
    <div class="space-y-2">
      ${renderToolHeader(MessageSquare, i18n("Notifying user"))}
      ${
        text
          ? html`<div class="rounded-lg border border-border px-3 py-2 text-sm">
            <markdown-block .content=${text}></markdown-block>
          </div>`
          : ""
      }
      ${result?.isError ? html`<div class="text-xs text-destructive">${resultText(result)}</div>` : ""}
    </div>
  `;
}

function renderTool(
  toolName: string,
  params: unknown,
  result: ToolResultMessageType | undefined,
  isStreaming?: boolean,
): TemplateResult {
  const name = toolName.toLowerCase();
  if (name === "bash") return renderBashTool(params, result);
  if (name === "edit") return renderEditTool(params, result);
  if (name === "write") return renderWriteTool(params, result);
  if (name === "read") return renderReadTool(params, result);
  if (name === "grep") return renderGrepTool(params, result);
  if (name === "ls" || name === "glob") return renderLsTool(params, result);
  if (name === "send_to_user") return renderSendToUserTool(params, result);
  return renderDefaultTool(params, result, isStreaming);
}

function summarizeToolCall(
  toolName: string,
  params: unknown,
  result: ToolResultMessageType | undefined,
  pending: boolean,
  isStreaming: boolean,
  aborted: boolean,
): { title: string; subtitle: string } {
  const state = aborted
    ? i18n("aborted")
    : result?.isError
      ? i18n("error")
      : result
        ? i18n("done")
        : pending || isStreaming
          ? i18n("running")
          : i18n("pending");

  const p = paramRecord(params);
  const name = toolName.toLowerCase();

  if (name === "bash") {
    const command = String(p.command ?? "");
    const preview = command.length > 80 ? `${command.slice(0, 80)}…` : command;
    return {
      title: toolName,
      subtitle: preview ? `${state} • ${preview}` : state,
    };
  }

  if (name === "edit" || name === "write" || name === "read") {
    const filePath = String(p.file_path ?? p.filePath ?? "");
    const short = filePath.split("/").slice(-2).join("/");
    return { title: toolName, subtitle: short ? `${state} • ${short}` : state };
  }

  if (name === "grep") {
    const pattern = String(p.pattern ?? "");
    return { title: toolName, subtitle: pattern ? `${state} • ${pattern}` : state };
  }

  if (name === "ls" || name === "glob") {
    const path = String(p.path ?? p.pattern ?? p.directory ?? ".");
    return { title: toolName, subtitle: `${state} • ${path}` };
  }

  if (name === "send_to_user") {
    const text = String(p.text ?? p.message ?? "");
    const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    return { title: "Notify User", subtitle: preview ? `${state} • ${preview}` : state };
  }

  return {
    title: toolName,
    subtitle: state,
  };
}

export class UserMessage extends LitElement {
  @property({ type: Object }) message!: UserMessageWithAttachments | UserMessageType;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "block";
  }

  override render() {
    if (!this.message?.content) return nothing;

    const contentArr =
      typeof this.message.content === "string"
        ? [{ type: "text" as const, text: this.message.content }]
        : this.message.content;
    const textContent = contentArr.find((chunk) => chunk.type === "text") as
      | TextContent
      | undefined;
    const imageBlocks = contentArr.filter((chunk) => chunk.type === "image") as ImageContent[];

    const plainText = textContent?.text || "";

    return html`
      <div class="flex justify-start mx-4">
        <div class="relative">
          <div class="user-message-container py-2 px-4 pr-8 rounded-xl">
            ${textContent?.text ? html`<markdown-block .content=${textContent.text}></markdown-block>` : ""}
            ${
              imageBlocks.length > 0
                ? html`
              <div class="flex flex-wrap gap-2 ${textContent?.text ? "mt-2" : ""}">
                ${imageBlocks.map(
                  (img) => html`
                  <img
                    src="data:${img.mimeType};base64,${img.data}"
                    alt="Attached image"
                    class="rounded-lg max-w-[240px] max-h-[240px] object-contain"
                  />
                `,
                )}
              </div>
            `
                : ""
            }
          </div>
          <message-copy-button .text=${plainText}></message-copy-button>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("user-message")) {
  customElements.define("user-message", UserMessage);
}

export class ToolMessageDebugView extends LitElement {
  @property({ type: Object }) callArgs: unknown;
  @property({ type: Object }) result?: ToolResultMessageType;
  @property({ type: Boolean }) hasResult = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "block";
  }

  override render() {
    const call = prettyValue(this.callArgs);
    const output = prettyValue(
      this.result?.content
        ?.filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n") || "",
    );

    return html`
      <div class="mt-3 flex flex-col gap-2">
        <div>
          <div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Call")}</div>
          <code-block .code=${encodeUtf8Base64(call.content)} language=${call.language}></code-block>
        </div>
        <div>
          <div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Result")}</div>
          ${
            this.hasResult
              ? html`<code-block .code=${encodeUtf8Base64(output.content)} language=${output.language}></code-block>`
              : html`<div class="text-xs text-muted-foreground">${i18n("(no result)")}</div>`
          }
        </div>
      </div>
    `;
  }
}

if (!customElements.get("tool-message-debug")) {
  customElements.define("tool-message-debug", ToolMessageDebugView);
}

export class ToolMessage extends LitElement {
  @property({ type: Object }) toolCall!: ToolCall;
  @property({ type: Object }) tool?: AgentTool;
  @property({ type: Object }) result?: ToolResultMessageType;
  @property({ type: Boolean }) pending = false;
  @property({ type: Boolean }) aborted = false;
  @property({ type: Boolean }) isStreaming = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "block";
  }

  override render() {
    const toolName = this.tool?.name || this.toolCall.name;
    const effectiveResult = this.aborted
      ? ({
          role: "toolResult",
          isError: true,
          content: [],
          toolCallId: this.toolCall.id,
          toolName: this.toolCall.name,
          timestamp: Date.now(),
        } as ToolResultMessageType)
      : this.result;
    const summary = summarizeToolCall(
      toolName,
      this.toolCall.arguments,
      effectiveResult,
      this.pending,
      this.isStreaming,
      this.aborted,
    );

    return html`
      <details class="tool-disclosure border border-border rounded-md bg-card text-card-foreground shadow-xs">
        <summary class="tool-disclosure-summary list-none cursor-pointer select-none px-3 py-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="tool-disclosure-chevron text-muted-foreground shrink-0">${unsafeHTML(iconSvg(ChevronRight, "sm"))}</span>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium leading-none truncate">${summary.title}</div>
              <div class="text-xs text-muted-foreground truncate mt-1">${summary.subtitle}</div>
            </div>
          </div>
        </summary>
        <div class="px-3 pb-3 pt-1">
          ${renderTool(toolName, this.toolCall.arguments, effectiveResult, !this.aborted && (this.isStreaming || this.pending))}
        </div>
      </details>
    `;
  }
}

if (!customElements.get("tool-message")) {
  customElements.define("tool-message", ToolMessage);
}

export class AssistantMessage extends LitElement {
  @property({ type: Object }) message!: AssistantMessageType;
  @property({ type: Array }) tools?: AgentTool[];
  @property({ type: Object }) pendingToolCalls?: Set<string>;
  @property({ type: Boolean }) hideToolCalls = false;
  @property({ type: Object }) toolResultsById?: Map<string, ToolResultMessageType>;
  @property({ type: Boolean }) isStreaming = false;
  @property({ attribute: false }) onCostClick?: () => void;
  /** When set, overrides the self-computed text for the copy button. Empty string hides it. */
  @property({ attribute: false }) copyText?: string;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "block";
  }

  override render() {
    if (!this.message?.content) return nothing;

    const orderedParts: TemplateResult[] = [];

    for (const chunk of this.message.content) {
      if (chunk.type === "text" && chunk.text.trim() !== "") {
        orderedParts.push(html`<markdown-block .content=${chunk.text}></markdown-block>`);
      } else if (chunk.type === "thinking" && chunk.thinking.trim() !== "") {
        orderedParts.push(
          html`<thinking-block .content=${chunk.thinking} .isStreaming=${this.isStreaming}></thinking-block>`,
        );
      } else if (chunk.type === "toolCall" && !this.hideToolCalls) {
        const tool = this.tools?.find((candidate) => candidate.name === chunk.name);
        const pending = this.pendingToolCalls?.has(chunk.id) ?? false;
        const result = this.toolResultsById?.get(chunk.id);
        const aborted = this.message.stopReason === "aborted" && !result;
        orderedParts.push(html`
          <tool-message
            .tool=${tool}
            .toolCall=${chunk}
            .result=${result}
            .pending=${pending}
            .aborted=${aborted}
            .isStreaming=${this.isStreaming}
          ></tool-message>
        `);
      }
    }

    // Use copyText override when provided; undefined means use self-computed text
    const effectiveCopyText = this.copyText !== undefined
      ? this.copyText
      : this.message.content
          .filter((chunk): chunk is { type: "text"; text: string } => chunk.type === "text" && chunk.text.trim() !== "")
          .map((chunk) => chunk.text)
          .join("\n");

    return html`
      <div class="relative">
        ${orderedParts.length ? html`<div class="px-4 pr-8 flex flex-col gap-3">${orderedParts}</div>` : ""}
        ${effectiveCopyText ? html`<message-copy-button .text=${effectiveCopyText}></message-copy-button>` : ""}
        ${
          this.message.usage && !this.isStreaming
            ? this.onCostClick
              ? html`<div class="px-4 mt-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${formatUsage(this.message.usage)}</div>`
              : html`<div class="px-4 mt-2 text-xs text-muted-foreground">${formatUsage(this.message.usage)}</div>`
            : ""
        }
        ${
          this.message.stopReason === "error" && this.message.errorMessage
            ? html`
              <div class="mx-4 mt-3 p-3 bg-destructive/10 text-destructive rounded-lg text-sm overflow-hidden">
                <strong>${i18n("Error:")}</strong> ${this.message.errorMessage}
              </div>
            `
            : ""
        }
        ${
          this.message.stopReason === "aborted"
            ? html`<span class="text-sm text-destructive italic">${i18n("Request aborted")}</span>`
            : ""
        }
      </div>
    `;
  }
}

if (!customElements.get("assistant-message")) {
  customElements.define("assistant-message", AssistantMessage);
}

export class MessageList extends LitElement {
  @property({ type: Array }) messages: RenderMessage[] = [];
  @property({ type: Array }) tools: AgentTool[] = [];
  @property({ type: Object }) pendingToolCalls?: Set<string>;
  @property({ attribute: false }) onCostClick?: () => void;

  private _streamingEl: AssistantMessage | null = null;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "block";
  }

  /**
   * Imperatively update the streaming assistant-message element.
   * Creates the element on first call, appends it after the repeat() container.
   * isThinkingStreaming controls whether the ThinkingBlock renders expanded with
   * the shimmer animation (true = thinking in progress, false = thinking done).
   */
  updateStreaming(msg: AssistantMessageType, isThinkingStreaming = false): void {
    if (!this._streamingEl) {
      this._streamingEl = document.createElement(
        "assistant-message",
      ) as unknown as AssistantMessage;
      this._streamingEl.style.display = "block";
      this._streamingEl.hideToolCalls = false;
      const container = this.querySelector(":scope > div");
      if (container) {
        container.appendChild(this._streamingEl as unknown as Node);
      }
    }
    this._streamingEl.isStreaming = isThinkingStreaming;
    this._streamingEl.message = msg;
    this._streamingEl.style.display = "block";
  }

  /**
   * Hide the streaming element with a brief delay so the completed message
   * from the next Lit render cycle can take its place without a flash.
   */
  clearStreaming(): void {
    const el = this._streamingEl;
    if (!el) return;
    // Delay hiding until after the next frame so React/Lit can commit the
    // completed message into the repeat() list first.
    requestAnimationFrame(() => {
      el.style.display = "none";
    });
  }

  /** Extract plain text from an assistant message's content chunks. */
  private static getAssistantPlainText(msg: AssistantMessageType): string {
    return (msg.content || [])
      .filter((chunk): chunk is { type: "text"; text: string } => chunk.type === "text" && chunk.text.trim() !== "")
      .map((chunk) => chunk.text)
      .join("\n");
  }

  private buildRenderItems(): Array<{ key: string; template: TemplateResult }> {
    const resultByCallId = new Map<string, ToolResultMessageType>();
    for (const message of this.messages) {
      if ((message as unknown as { role: string }).role === "toolResult") {
        resultByCallId.set(
          (message as ToolResultMessageType).toolCallId,
          message as ToolResultMessageType,
        );
      }
    }

    // Pre-pass: group assistant messages between user messages so we can
    // show a single copy button on the last assistant in each group with
    // the concatenated text of the entire group.
    // Build groups split by user messages
    const groups: AssistantMessageType[][] = [];
    let currentGroup: AssistantMessageType[] = [];
    for (const msg of this.messages) {
      const role = (msg as unknown as { role: string }).role;
      if (role === "user" || role === "user-with-attachments") {
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
          currentGroup = [];
        }
      } else if (role === "assistant") {
        currentGroup.push(msg as AssistantMessageType);
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    // Map each assistant message to its copyText: empty for non-last, concatenated for last
    const copyTextByTimestamp = new Map<number | undefined, string>();
    for (const group of groups) {
      const concatenated = group
        .map((m) => MessageList.getAssistantPlainText(m))
        .filter(Boolean)
        .join("\n");
      for (let i = 0; i < group.length; i++) {
        const ts = (group[i] as unknown as { timestamp?: number }).timestamp;
        copyTextByTimestamp.set(ts, i === group.length - 1 ? concatenated : "");
      }
    }

    const items: Array<{ key: string; template: TemplateResult }> = [];
    let fallbackIndex = 0;

    for (const msg of this.messages) {
      const role = (msg as unknown as { role: string }).role;
      if (role === "artifact" || role === "toolResult") {
        continue;
      }

      const ts = (msg as unknown as { timestamp?: number }).timestamp;
      const key = ts != null ? `${role}:${ts}` : `msg:${fallbackIndex}`;
      fallbackIndex++;

      if (role === "user" || role === "user-with-attachments") {
        items.push({
          key,
          template: html`<user-message .message=${msg}></user-message>`,
        });
        continue;
      }

      if (role === "assistant") {
        const copyText = copyTextByTimestamp.get(ts) ?? "";
        items.push({
          key,
          template: html`
            <assistant-message
              .message=${msg as AssistantMessageType}
              .tools=${this.tools}
              .isStreaming=${false}
              .pendingToolCalls=${this.pendingToolCalls}
              .toolResultsById=${resultByCallId}
              .hideToolCalls=${false}
              .onCostClick=${this.onCostClick}
              .copyText=${copyText}
            ></assistant-message>
          `,
        });
      }
    }

    return items;
  }

  override render() {
    const items = this.buildRenderItems();
    return html`<div class="flex flex-col gap-3">
      ${repeat(
        items,
        (item) => item.key,
        (item) => item.template,
      )}
    </div>`;
  }
}

if (!customElements.get("message-list")) {
  customElements.define("message-list", MessageList);
}
