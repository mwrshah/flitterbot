import { marked } from "marked";
import { type JSX, memo, type ReactNode, useMemo } from "react";
import { safeMarkdownUrl } from "~/lib/markdown-html";

// Marked is shimmed as `any` in this app; normalize tokens at the boundary and keep local access typed.
type MarkdownToken = {
  type?: string;
  raw?: unknown;
  text?: unknown;
  tokens?: MarkdownToken[];
  href?: unknown;
  title?: unknown;
  depth?: unknown;
  ordered?: unknown;
  start?: unknown;
  items?: MarkdownToken[];
  lang?: unknown;
  header?: MarkdownToken[];
  rows?: MarkdownToken[][];
};

function tokenText(token: MarkdownToken): string {
  return String(token.text ?? token.raw ?? "");
}

function tokenTitle(token: MarkdownToken): string | undefined {
  return typeof token.title === "string" && token.title ? token.title : undefined;
}

function MarkdownInlineTokens({ tokens }: { tokens: MarkdownToken[] | undefined }) {
  if (!tokens?.length) return null;
  return tokens.map((token, index) => (
    <MarkdownInline
      token={token}
      key={`${token.type ?? "token"}:${token.raw ?? token.text ?? index}`}
    />
  ));
}

function MarkdownInline({ token }: { token: MarkdownToken }): ReactNode {
  switch (token.type) {
    case "strong":
      return (
        <strong>
          <MarkdownInlineTokens tokens={token.tokens} />
        </strong>
      );
    case "em":
      return (
        <em>
          <MarkdownInlineTokens tokens={token.tokens} />
        </em>
      );
    case "del":
      return (
        <del>
          <MarkdownInlineTokens tokens={token.tokens} />
        </del>
      );
    case "codespan":
      return <code>{tokenText(token)}</code>;
    case "br":
      return <br />;
    case "link": {
      const href = safeMarkdownUrl(token.href);
      const children = token.tokens?.length ? (
        <MarkdownInlineTokens tokens={token.tokens} />
      ) : (
        tokenText(token)
      );
      return href ? (
        <a href={href} title={tokenTitle(token)} target="_blank" rel="noreferrer">
          {children}
        </a>
      ) : (
        children
      );
    }
    case "image": {
      const src = safeMarkdownUrl(token.href);
      return src ? (
        <img src={src} alt={tokenText(token)} title={tokenTitle(token)} />
      ) : (
        tokenText(token)
      );
    }
    case "html":
      return tokenText(token);
    default:
      return token.tokens?.length ? (
        <MarkdownInlineTokens tokens={token.tokens} />
      ) : (
        tokenText(token)
      );
  }
}

function MarkdownBlocks({ tokens }: { tokens: MarkdownToken[] | undefined }) {
  if (!tokens?.length) return null;
  return tokens.map((token, index) => (
    <MarkdownBlock
      token={token}
      key={`${token.type ?? "block"}:${token.raw ?? token.text ?? index}`}
    />
  ));
}

function MarkdownBlock({ token }: { token: MarkdownToken }): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "hr":
      return <hr />;
    case "heading": {
      const Tag =
        `h${Math.min(Math.max(Number(token.depth) || 2, 1), 6)}` as keyof JSX.IntrinsicElements;
      return (
        <Tag>
          <MarkdownInlineTokens tokens={token.tokens} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p>
          <MarkdownInlineTokens tokens={token.tokens} />
        </p>
      );
    case "text":
      return (
        <p>
          {token.tokens?.length ? <MarkdownInlineTokens tokens={token.tokens} /> : tokenText(token)}
        </p>
      );
    case "blockquote":
      return (
        <blockquote>
          <MarkdownBlocks tokens={token.tokens} />
        </blockquote>
      );
    case "list": {
      const ListTag = token.ordered ? "ol" : "ul";
      return (
        <ListTag start={typeof token.start === "number" ? token.start : undefined}>
          {(token.items ?? []).map((item: MarkdownToken) => (
            <li key={`${item.raw ?? item.text ?? "item"}`}>
              <MarkdownBlocks tokens={item.tokens} />
            </li>
          ))}
        </ListTag>
      );
    }
    case "code":
      return (
        <pre>
          <code className={token.lang ? `language-${String(token.lang)}` : undefined}>
            {tokenText(token)}
          </code>
        </pre>
      );
    case "table":
      return (
        <table>
          <thead>
            <tr>
              {(token.header ?? []).map((cell: MarkdownToken) => (
                <th key={`${cell.raw ?? cell.text ?? "header"}`}>
                  <MarkdownInlineTokens tokens={cell.tokens} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(token.rows ?? []).map((row: MarkdownToken[], rowIndex: number) => (
              <tr
                key={
                  row.map((cell) => cell.raw ?? cell.text ?? "cell").join("|") || String(rowIndex)
                }
              >
                {row.map((cell) => (
                  <td key={`${cell.raw ?? cell.text ?? "cell"}`}>
                    <MarkdownInlineTokens tokens={cell.tokens} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "html":
      return <p>{tokenText(token)}</p>;
    default:
      return token.tokens?.length ? (
        <MarkdownBlocks tokens={token.tokens} />
      ) : (
        <p>{tokenText(token)}</p>
      );
  }
}

export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const tokens = useMemo(() => marked.lexer(content) as MarkdownToken[], [content]);
  return (
    <div className="markdown-body text-sm text-foreground break-words">
      <MarkdownBlocks tokens={tokens} />
    </div>
  );
});
