import { marked } from 'marked';
import { memo, useMemo } from 'react';

const renderer = new marked.Renderer();
const originalLink = renderer.link;
renderer.link = function (...args: Parameters<typeof originalLink>) {
  const link = originalLink.apply(this, args);
  return link.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
};

const parseCache = new Map<string, string>();

function parseMarkdown(content: string): string {
  const cached = parseCache.get(content);
  if (cached) return cached;
  const html = marked.parse(content, { async: false, renderer }) as string;
  parseCache.set(content, html);
  return html;
}

export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(() => parseMarkdown(content), [content]);
  return (
    <div
      className="markdown-body text-sm text-foreground break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
