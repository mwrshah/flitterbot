import { streamingMarkdownExtension } from "@tanstack/markdown/extensions/streaming";
import {
  Markdown,
  type MarkdownComponentProps,
  type MarkdownComponents,
} from "@tanstack/markdown/react";
import {
  createContext,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useContext,
  useId,
} from "react";
import { CodeBlock } from "@/components/common/code-block";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import { namespacedFootnoteId, safeMarkdownUrl } from "@/lib/markdown";

const MarkdownFootnoteNamespace = createContext("");

function MarkdownLink({
  href,
  id,
  "aria-describedby": describedBy,
  children,
  ...props
}: MarkdownComponentProps<"a">) {
  useWhyDidYouRender?.("MarkdownLink", {});
  const namespace = useContext(MarkdownFootnoteNamespace);
  const safeHref = safeMarkdownUrl(href);
  if (!safeHref) return <>{children}</>;

  const renderedHref = safeHref.startsWith("#user-content-fn")
    ? `#${namespace}-${safeHref.slice(1)}`
    : safeHref;
  const renderedId = namespacedFootnoteId(id, namespace);
  const renderedDescription = describedBy
    ?.split(" ")
    .map((value) => namespacedFootnoteId(value, namespace))
    .join(" ");
  const external = !renderedHref.startsWith("#");

  return (
    <a
      {...props}
      href={renderedHref}
      id={renderedId}
      aria-describedby={renderedDescription}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
    >
      {children}
    </a>
  );
}

function MarkdownFootnoteContainer({ id, children, ...props }: MarkdownComponentProps<"li">) {
  useWhyDidYouRender?.("MarkdownFootnoteContainer", {});
  const namespace = useContext(MarkdownFootnoteNamespace);
  return (
    <li {...props} id={namespacedFootnoteId(id, namespace)}>
      {children}
    </li>
  );
}

function MarkdownFootnoteHeading({ id, children, ...props }: MarkdownComponentProps<"h2">) {
  useWhyDidYouRender?.("MarkdownFootnoteHeading", {});
  const namespace = useContext(MarkdownFootnoteNamespace);
  return (
    <h2 {...props} id={namespacedFootnoteId(id, namespace)}>
      {children}
    </h2>
  );
}

function MarkdownImage({ src, alt, ...props }: MarkdownComponentProps<"img">) {
  useWhyDidYouRender?.("MarkdownImage", {});
  const safeSrc = safeMarkdownUrl(src);
  if (!safeSrc) return <>{alt}</>;

  return (
    <img
      {...props}
      src={safeSrc}
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
      className="max-h-[480px] max-w-full object-contain"
    />
  );
}

type CodeChildProps = {
  children?: ReactNode;
  className?: string;
};

function codeChild(children: ReactNode): ReactElement<CodeChildProps> | null {
  return isValidElement<CodeChildProps>(children) ? children : null;
}

type MarkdownPreProps = MarkdownComponentProps<"pre"> & { "data-lang"?: string };

function renderMarkdownPre(
  { children, "data-lang": dataLanguage, ...props }: MarkdownPreProps,
  highlight: boolean,
) {
  const code = codeChild(children);
  if (!code) return <pre {...props}>{children}</pre>;

  const classLanguage = code.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
  const language = dataLanguage ?? classLanguage;

  return (
    <CodeBlock code={String(code.props.children ?? "")} language={language} highlight={highlight} />
  );
}

function MarkdownPre(props: MarkdownPreProps) {
  useWhyDidYouRender?.("MarkdownPre", {});
  return renderMarkdownPre(props, true);
}

function StreamingMarkdownPre(props: MarkdownPreProps) {
  useWhyDidYouRender?.("StreamingMarkdownPre", {});
  return renderMarkdownPre(props, false);
}

const markdownComponents = {
  a: MarkdownLink,
  h2: MarkdownFootnoteHeading,
  img: MarkdownImage,
  li: MarkdownFootnoteContainer,
  pre: MarkdownPre,
} satisfies MarkdownComponents;

const streamingMarkdownComponents = {
  ...markdownComponents,
  pre: StreamingMarkdownPre,
} satisfies MarkdownComponents;

const streamingExtensions = [streamingMarkdownExtension()];

export const MarkdownContent = memo(function MarkdownContent({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  useWhyDidYouRender?.("MarkdownContent", {});
  const namespace = `markdown-${useId().replaceAll(":", "")}`;
  return (
    <MarkdownFootnoteNamespace.Provider value={namespace}>
      <div className="markdown-content break-words text-text">
        <Markdown
          allowHtml={false}
          frontmatter={false}
          headingIds={false}
          components={streaming ? streamingMarkdownComponents : markdownComponents}
          extensions={streaming ? streamingExtensions : undefined}
        >
          {content}
        </Markdown>
      </div>
    </MarkdownFootnoteNamespace.Provider>
  );
});
