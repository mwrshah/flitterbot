import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import htmlLanguage from "highlight.js/lib/languages/xml";
import { Check, Copy } from "lucide-react";
import { useMemo } from "react";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("html", htmlLanguage);
hljs.registerLanguage("xml", htmlLanguage);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);

const MAX_HIGHLIGHT_CHARS = 50_000;
const PLAIN_TEXT_LANGUAGES = new Set(["text", "txt", "plaintext"]);

export function CodeBlock({
  code,
  language,
  highlight = true,
}: {
  code: string;
  language?: string;
  highlight?: boolean;
}) {
  const { copied, copy } = useCopyToClipboard(1500);
  const displayLanguage = language || "plaintext";
  const highlighted = useMemo(() => {
    const normalizedLanguage = language?.toLowerCase();
    if (
      !highlight ||
      code.length > MAX_HIGHLIGHT_CHARS ||
      !normalizedLanguage ||
      PLAIN_TEXT_LANGUAGES.has(normalizedLanguage) ||
      !hljs.getLanguage(normalizedLanguage)
    ) {
      return undefined;
    }
    return hljs.highlight(code, { language: normalizedLanguage }).value;
  }, [code, highlight, language]);
  const copyLabel = copied ? "Copied" : "Copy code";

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-background-muted px-3 py-1.5">
        <span className="font-mono text-xs text-text-muted">{displayLanguage}</span>
        <button
          type="button"
          onClick={() =>
            void copy(code).catch((error) => console.error("Failed to copy code", error))
          }
          data-copied={copied ? "true" : "false"}
          className="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-background-hover hover:text-text"
          title={copyLabel}
          aria-label={copyLabel}
          aria-live="polite"
        >
          {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
        </button>
      </div>
      <div className="max-h-96 overflow-auto">
        <pre className="m-0 rounded-none border-0 !bg-transparent px-4 pb-4 pt-3 font-mono text-xs text-text">
          {highlighted === undefined ? (
            <code className={`hljs language-${displayLanguage}`}>{code}</code>
          ) : (
            <code
              className={`hljs language-${displayLanguage}`}
              // highlight.js escapes source text before adding its own trusted token markup.
              // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted highlight.js output
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          )}
        </pre>
      </div>
    </div>
  );
}
