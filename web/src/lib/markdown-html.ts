import { marked } from "marked";

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeMarkdownUrl(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith("#") || value.startsWith("/")) return value;

  try {
    const parsed = new URL(value);
    return SAFE_URL_PROTOCOLS.has(parsed.protocol) ? value : null;
  } catch {
    return null;
  }
}

function rendererLinkArgs(args: unknown[]): { href: unknown; title: unknown; text: string } {
  const [first, title, text] = args;
  if (first && typeof first === "object") {
    const token = first as { href?: unknown; title?: unknown; text?: unknown };
    return { href: token.href, title: token.title, text: String(token.text ?? "") };
  }
  return { href: first, title, text: String(text ?? "") };
}

function rendererHtmlArg(args: unknown[]): string {
  const [first] = args;
  if (first && typeof first === "object") {
    const token = first as { text?: unknown; raw?: unknown };
    return String(token.text ?? token.raw ?? "");
  }
  return String(first ?? "");
}

function createSafeMarkedRenderer() {
  const renderer = new marked.Renderer();

  renderer.html = (...args: unknown[]) => escapeHtml(rendererHtmlArg(args));

  renderer.link = (...args: unknown[]) => {
    const { href, title, text } = rendererLinkArgs(args);
    const safeHref = safeMarkdownUrl(href);
    if (!safeHref) return text;
    const safeTitle = title ? ` title="${escapeHtml(String(title))}"` : "";
    return `<a href="${escapeHtml(safeHref)}"${safeTitle} target="_blank" rel="noopener noreferrer">${text}</a>`;
  };

  renderer.image = (...args: unknown[]) => {
    const { href, title, text } = rendererLinkArgs(args);
    const safeHref = safeMarkdownUrl(href);
    if (!safeHref) return escapeHtml(text);
    const safeTitle = title ? ` title="${escapeHtml(String(title))}"` : "";
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"${safeTitle}>`;
  };

  return renderer;
}

export function renderSafeMarkdownHtml(content: string): string {
  return marked.parse(content, { async: false, renderer: createSafeMarkedRenderer() }) as string;
}
