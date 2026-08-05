const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export function safeMarkdownUrl(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith("#") || (value.startsWith("/") && !value.startsWith("//"))) return value;

  try {
    return SAFE_URL_PROTOCOLS.has(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

export function namespacedFootnoteId(value: string | undefined, namespace: string) {
  if (!value) return value;
  return value === "footnote-label" ||
    value.startsWith("user-content-fn-") ||
    value.startsWith("user-content-fnref-")
    ? `${namespace}-${value}`
    : value;
}
