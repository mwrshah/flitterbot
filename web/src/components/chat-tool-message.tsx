import { useMutation } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  Code,
  Copy,
  FolderOpen,
  MessageSquare,
  Search,
  SquareTerminal,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CodeBlock } from "@/components/common/code-block";
import { MarkdownContent } from "@/components/common/markdown-content";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { type ActiveToolState, useConversationToolState } from "@/lib/conversation-state";
import type { ChatTimelineTool, SwimlaneLaunchArgs } from "@/lib/types";

const rootRouteApi = getRouteApi("__root__");
const preparedLaunchStore = new Map<string, { json?: string; launched?: true }>();
const MAX_EDIT_DIFF_ROWS = 160;
const HEADER_COPY_BUTTON_CLASS =
  "flex items-center gap-1 rounded px-2 py-0.5 text-xs text-text-muted transition-colors hover:bg-background-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop focus-visible:ring-offset-2 focus-visible:ring-offset-background-muted data-[copied=true]:cursor-default data-[copied=true]:text-status-active data-[copied=true]:hover:bg-transparent data-[copied=true]:hover:text-status-active";

type ToolMessageProps = {
  item: ChatTimelineTool;
  endItem?: ChatTimelineTool;
  piSessionId: string;
};

type ToolResult = { text: string; isError: boolean };

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resultText(value: unknown): string {
  if (typeof value === "object" && value && "content" in value) {
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .flatMap((part) =>
          typeof part === "object" &&
          part &&
          "type" in part &&
          part.type === "text" &&
          "text" in part
            ? [String(part.text)]
            : [],
        )
        .join("\n");
    }
  }
  return stringify(value);
}

function effectiveResult(
  endItem: ChatTimelineTool | undefined,
  active: ActiveToolState | undefined,
): ToolResult | undefined {
  if (endItem) {
    return {
      text: resultText(endItem.result),
      isError: Boolean(endItem.isError),
    };
  }
  if (active && (active.partialResult !== undefined || active.isError)) {
    return {
      text: resultText(active.partialResult),
      isError: Boolean(active.isError),
    };
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value ? (value as Record<string, unknown>) : {};
}

function pretty(value: unknown): { content: string; language: string } {
  if (typeof value === "string") {
    try {
      return { content: JSON.stringify(JSON.parse(value), null, 2), language: "json" };
    } catch {
      return { content: value, language: "text" };
    }
  }
  return { content: stringify(value), language: value == null ? "text" : "json" };
}

function ToolHeader({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-text-muted">
      <span className="inline-block text-text">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { copied, copy } = useCopyToClipboard();
  const label = copied ? "Copied" : "Copy output";
  return (
    <button
      type="button"
      className={HEADER_COPY_BUTTON_CLASS}
      data-copied={copied}
      title={label}
      aria-label={label}
      aria-live="polite"
      onClick={() => void copy(text).catch((error) => console.error("Copy failed", error))}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </button>
  );
}

function ConsoleBlock({ content, error }: { content: string; error: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [content]);
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-background-muted px-3 py-1.5">
        <span className="font-mono text-xs text-text-muted">console</span>
        <CopyButton text={content} />
      </div>
      <div ref={scroll} className="console-scroll max-h-64 overflow-auto">
        <pre
          className={`m-0 whitespace-pre-wrap !rounded-none !border-0 !bg-background p-3 font-mono text-xs ${error ? "text-status-crashed" : "text-text"}`}
        >
          {content}
        </pre>
      </div>
    </div>
  );
}

type DiffRow =
  | { type: "context"; oldLine: number; newLine: number; content: string }
  | { type: "delete"; oldLine: number; content: string }
  | { type: "insert"; newLine: number; content: string }
  | { type: "omitted"; content: string };

function lines(text: string): string[] {
  if (!text) return [];
  const result = text.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function diffRows(oldText: string, newText: string): DiffRow[] {
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)
  )
    suffix++;
  const rows: DiffRow[] = [];
  for (let i = 0; i < prefix; i++)
    rows.push({ type: "context", oldLine: i + 1, newLine: i + 1, content: oldLines[i] ?? "" });
  for (let i = prefix; i < oldLines.length - suffix; i++)
    rows.push({ type: "delete", oldLine: i + 1, content: oldLines[i] ?? "" });
  for (let i = prefix; i < newLines.length - suffix; i++)
    rows.push({ type: "insert", newLine: i + 1, content: newLines[i] ?? "" });
  for (let i = 0; i < suffix; i++) {
    const oldIndex = oldLines.length - suffix + i;
    const newIndex = newLines.length - suffix + i;
    rows.push({
      type: "context",
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
      content: oldLines[oldIndex] ?? "",
    });
  }
  return rows;
}

function editRows(params: Record<string, unknown>): DiffRow[] {
  const oldText = params.old_string ?? params.oldString;
  const newText = params.new_string ?? params.newString;
  if (oldText != null || newText != null)
    return diffRows(String(oldText ?? ""), String(newText ?? ""));
  return Array.isArray(params.edits)
    ? params.edits.flatMap((edit, index) => {
        const value = record(edit);
        const rows = diffRows(
          String(value.oldText ?? value.old_string ?? value.oldString ?? ""),
          String(value.newText ?? value.new_string ?? value.newString ?? ""),
        );
        return index ? [{ type: "omitted" as const, content: "" }, ...rows] : rows;
      })
    : [];
}

function Diff({ rows }: { rows: DiffRow[] }) {
  const visible =
    rows.length <= MAX_EDIT_DIFF_ROWS
      ? rows
      : [
          ...rows.slice(0, MAX_EDIT_DIFF_ROWS),
          {
            type: "omitted" as const,
            content: `… ${rows.length - MAX_EDIT_DIFF_ROWS} more diff lines`,
          },
        ];
  return (
    <div className="diff-viewer-panel overflow-x-auto rounded-sm border border-border text-xs">
      <table className="diff">
        <colgroup>
          <col className="diff-gutter-col" />
          <col className="diff-gutter-col" />
          <col />
        </colgroup>
        <tbody className="diff-hunk">
          {visible.map((row, index) => {
            if (row.type === "omitted")
              return (
                <tr className="diff-line diff-line-normal" key={index}>
                  <td className="diff-gutter diff-gutter-normal" colSpan={2} />
                  <td className="diff-code diff-code-normal text-text-muted">{row.content}</td>
                </tr>
              );
            const type = row.type === "context" ? "normal" : row.type;
            return (
              <tr className={`diff-line diff-line-${type}`} key={index}>
                <td className={`diff-gutter diff-gutter-${type}`}>
                  {row.type === "insert" ? "" : row.oldLine}
                </td>
                <td className={`diff-gutter diff-gutter-${type}`}>
                  {row.type === "delete" ? "" : row.newLine}
                </td>
                <td className={`diff-code diff-code-${type}`}>
                  {row.type === "insert" ? "+" : row.type === "delete" ? "-" : " "}
                  {row.content}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ErrorText({ result }: { result?: ToolResult }) {
  return result?.isError && result.text ? (
    <div className="text-xs text-status-crashed">{result.text}</div>
  ) : null;
}

function PreparedLaunchCard({
  launch,
  piSessionId,
  stateKey,
}: {
  launch: unknown;
  piSessionId: string;
  stateKey: string;
}) {
  const { apiClient } = rootRouteApi.useRouteContext();
  const stored = preparedLaunchStore.get(stateKey);
  const [json, setJson] = useState(() => stored?.json ?? JSON.stringify(launch, null, 2));
  const [launched, setLaunched] = useState(() => stored?.launched ?? false);
  const create = useMutation({
    mutationFn: (value: string) =>
      apiClient.createSwimlane({
        ...(JSON.parse(value) as SwimlaneLaunchArgs),
        sourcePiSessionId: piSessionId,
      }),
    onSuccess: ({ streamName, warning }) => {
      preparedLaunchStore.set(stateKey, { ...preparedLaunchStore.get(stateKey), launched: true });
      setLaunched(true);
      warning ? toast.warning(warning) : toast.success(`Started swimlane: ${streamName}`);
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    create.mutate(json);
  };

  return (
    <form onSubmit={submit}>
      <div className="relative">
        <label className="relative block min-w-0 before:pointer-events-none before:absolute before:inset-0 before:z-10 before:rounded-xl before:border-2 before:border-border-pop before:opacity-0 before:content-[''] focus-within:before:opacity-100">
          <span className="sr-only">Swimlane launch arguments</span>
          <textarea
            value={json}
            onChange={(event) => {
              setJson(event.target.value);
              preparedLaunchStore.set(stateKey, {
                ...preparedLaunchStore.get(stateKey),
                json: event.target.value,
              });
              if (create.isError) create.reset();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (!create.isPending && !launched) event.currentTarget.form?.requestSubmit();
            }}
            spellCheck={false}
            className="field-sizing-content block w-full resize-none overflow-hidden rounded-xl border border-border bg-background-selected py-2 pr-14 pl-4 font-mono text-base text-text focus-visible:outline-none md:pr-12 md:text-xs"
          />
        </label>
        <button
          type="submit"
          disabled={create.isPending || launched}
          aria-label={launched ? "Swimlane launched" : "Launch prepared swimlane"}
          title={launched ? "Swimlane launched" : "Launch prepared swimlane"}
          className="absolute right-2 bottom-2 flex size-11 touch-manipulation items-center justify-center rounded text-text-muted transition-colors after:absolute after:-inset-1 enabled:hover:text-text-pop enabled:hover:[&_svg]:stroke-2 focus-visible:text-text-pop focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop focus-visible:[&_svg]:stroke-2 disabled:cursor-not-allowed md:size-8"
        >
          {launched ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <ArrowRight className="size-4" strokeWidth={1.5} aria-hidden="true" />
          )}
        </button>
      </div>
      {create.error ? (
        <p className="mt-1 text-xs text-status-crashed" role="alert">
          {create.error instanceof Error ? create.error.message : String(create.error)}
        </p>
      ) : null}
    </form>
  );
}

function ToolBody({
  name,
  params,
  result,
  running,
}: {
  name: string;
  params: unknown;
  result?: ToolResult;
  running: boolean;
}) {
  const p = record(params);
  if (name === "bash") {
    const command = String(p.command ?? "");
    const combined = command
      ? `> ${command}${result?.text ? `\n\n${result.text}` : ""}`
      : (result?.text ?? "");
    return (
      <div className="space-y-3">
        <ToolHeader icon={<SquareTerminal className="size-4" />}>
          {command ? "Running command…" : "Waiting for command…"}
        </ToolHeader>
        <ConsoleBlock content={combined} error={Boolean(result?.isError)} />
      </div>
    );
  }
  if (name === "edit") {
    const rows = editRows(p);
    let resultDiff = "";
    if (!rows.length && result?.text.trim())
      try {
        const parsed = record(JSON.parse(result.text));
        if (typeof parsed.diff === "string") resultDiff = parsed.diff;
      } catch {}
    return (
      <div className="space-y-2">
        {rows.length ? <Diff rows={rows} /> : null}
        {resultDiff ? (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-sm border border-border p-2 font-mono text-xs">
            {resultDiff}
          </pre>
        ) : null}
        <ErrorText result={result} />
      </div>
    );
  }
  if (name === "write")
    return (
      <div className="space-y-2">
        <Diff
          rows={lines(String(p.content ?? "")).map((content, index) => ({
            type: "insert",
            newLine: index + 1,
            content,
          }))}
        />
        <ErrorText result={result} />
      </div>
    );
  if (name === "read") {
    const output = result?.text ?? "";
    const all = output.split("\n");
    const truncated = all.length > 10;
    return (
      <div>
        {output ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-sm border border-border p-2 font-mono text-xs">
            {all.slice(0, 10).join("\n")}
            {truncated ? (
              <>
                <br />
                <span className="text-text-muted">… truncated</span>
              </>
            ) : null}
          </pre>
        ) : null}
        <ErrorText result={result} />
      </div>
    );
  }
  if (name === "grep" || name === "ls" || name === "glob") {
    const grep = name === "grep";
    const label = grep
      ? `grep ${String(p.pattern ?? "")} ${String(p.path ?? ".")}`
      : `ls ${String(p.path ?? p.directory ?? ".")}`;
    return (
      <div className="space-y-2">
        <ToolHeader icon={grep ? <Search className="size-4" /> : <FolderOpen className="size-4" />}>
          {label}
        </ToolHeader>
        {result?.text ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-sm border border-border p-2 font-mono text-xs">
            {result.text}
          </pre>
        ) : null}
        {grep ? <ErrorText result={result} /> : null}
      </div>
    );
  }
  if (name === "send_to_user") {
    const text = String(p.text ?? p.message ?? "");
    return (
      <div className="space-y-2">
        <ToolHeader icon={<MessageSquare className="size-4" />}>Notifying user</ToolHeader>
        {text ? (
          <div className="rounded-lg border border-border px-3 py-2 text-sm">
            <MarkdownContent content={text} />
          </div>
        ) : null}
        <ErrorText result={result} />
      </div>
    );
  }
  const input = pretty(params);
  const output = pretty(result?.text ?? "");
  return (
    <div className="space-y-3">
      <ToolHeader icon={<Code className="size-4" />}>
        {result
          ? result.isError
            ? "Tool failed"
            : "Tool Call"
          : running
            ? "Preparing tool…"
            : "Tool Call"}
      </ToolHeader>
      {input.content ? (
        <div>
          <div className="mb-1 text-xs font-medium text-text-muted">Input</div>
          <CodeBlock code={input.content} language={input.language} />
        </div>
      ) : null}
      {result ? (
        <div>
          <div className="mb-1 text-xs font-medium text-text-muted">Output</div>
          <CodeBlock code={output.content || "(no output)"} language={output.language} />
        </div>
      ) : null}
    </div>
  );
}

function pathParam(p: Record<string, unknown>): string {
  return String(p.path ?? p.file_path ?? p.filePath ?? "");
}

export function ToolMessage({ item, endItem, piSessionId }: ToolMessageProps) {
  const toolUseId = item.toolUseId;
  const active = useConversationToolState(piSessionId, toolUseId);
  const result = effectiveResult(endItem, active);
  const params = item.displayArgs ?? item.args;
  const toolName = item.tool;
  const name = toolName.toLowerCase();
  const running = !endItem && (active?.pending ?? true);
  const p = record(params);
  const title = name === "send_to_user" ? "Notify User" : toolName;
  const subtitle =
    name === "bash"
      ? String(p.command ?? "")
      : name === "edit" || name === "write" || name === "read"
        ? pathParam(p)
        : name === "grep"
          ? String(p.pattern ?? "")
          : name === "ls" || name === "glob"
            ? String(p.path ?? p.pattern ?? p.directory ?? ".")
            : name === "send_to_user"
              ? String(p.text ?? p.message ?? "")
              : "";
  const glyph = running ? "↺" : result?.isError ? "✕" : result ? "✓" : "↺";
  const launches =
    name === "prep_launch" && endItem && !endItem.isError ? record(item.args).launches : undefined;
  const [open, setOpen] = useState(name === "edit" || name === "write" || name === "prep_launch");
  return (
    <details
      className="tool-disclosure overflow-hidden rounded-sm bg-background text-text"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="tool-disclosure-summary group cursor-pointer select-none list-none pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <div className="shrink-0 truncate text-sm font-medium leading-none group-hover:underline select-text">
              <span className="inline-block w-[1em] text-center">{glyph}</span> {title}
            </div>
            <div className="min-w-0 truncate text-xs leading-none text-text-muted group-hover:underline select-text">
              {subtitle}
            </div>
          </div>
        </div>
      </summary>
      <div className="pb-3 pt-1">
        {Array.isArray(launches) && launches.length > 0 ? (
          <div className="space-y-2" role="group" aria-label="Prepared swimlane launches">
            {launches.map((launch, index) => (
              <PreparedLaunchCard
                key={`${toolUseId}:${index}`}
                stateKey={`${toolUseId}:${index}`}
                launch={launch}
                piSessionId={piSessionId}
              />
            ))}
          </div>
        ) : (
          <ToolBody name={name} params={params} result={result} running={running} />
        )}
      </div>
    </details>
  );
}
