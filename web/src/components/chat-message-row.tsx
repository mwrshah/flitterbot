import { CheckIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { ToolMessage } from "~/components/chat-tool-message";
import { MarkdownContent } from "~/components/common/markdown-content";
import { MessageActionsMenu } from "~/components/message-actions-menu";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";
import {
  buildConversationContentParts,
  type ConversationRow,
  type ConversationToolBlock,
} from "~/lib/conversation-rows";
import {
  type ConversationStreamingState,
  useConversationStreaming,
} from "~/lib/conversation-state";
import type { ChatTimelineMessage } from "~/lib/types";

const SINGLE_LINE_TOLERANCE_PX = 3;

function isSingleLine(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const number = (value: string) => Number.parseFloat(value) || 0;
  const insets =
    number(style.paddingTop) +
    number(style.paddingBottom) +
    number(style.borderTopWidth) +
    number(style.borderBottomWidth);
  const lineHeight = number(style.lineHeight) || number(style.fontSize) * 1.2 || 20;
  return element.getBoundingClientRect().height - insets <= lineHeight + SINGLE_LINE_TOLERANCE_PX;
}

function MessageCopyButton({ text, target }: { text: string; target: HTMLElement | null }) {
  const [singleLine, setSingleLine] = useState(true);
  const { copied, copy } = useCopyToClipboard();

  useLayoutEffect(() => {
    if (!target) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSingleLine(isSingleLine(target)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [target]);

  if (!text || singleLine) return null;
  const label = copied ? "Copied" : "Copy message";
  const Icon = copied ? CheckIcon : CopyIcon;
  return (
    <button
      type="button"
      onClick={() =>
        void copy(text).catch((error) => console.error("Failed to copy message", error))
      }
      data-copied={copied}
      className="absolute right-1.5 bottom-1.5 cursor-pointer touch-manipulation rounded p-1 text-text-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[copied=false]:hover:text-text data-[copied=true]:cursor-default data-[copied=true]:text-status-active"
      title={label}
      aria-label={label}
      aria-live="polite"
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

function ThinkingBlock({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);
  return (
    <div className="thinking-block">
      <button
        type="button"
        className="thinking-header flex w-full touch-manipulation items-center justify-between gap-3 rounded-sm px-1 pb-1 pl-0 text-left text-base text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className={
            streaming
              ? "animate-shimmer bg-gradient-to-r from-text-muted via-text to-text-muted bg-[length:200%_100%] bg-clip-text text-transparent"
              : undefined
          }
        >
          Thinking…
        </span>
        <span className="shrink-0 text-[11px] tracking-[0.16em] text-text-muted uppercase">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <div className="pt-1 pb-2 pl-2">
          <MarkdownContent content={content} streaming={streaming} />
        </div>
      )}
    </div>
  );
}

function ToolBlock({ tool, piSessionId }: { tool: ConversationToolBlock; piSessionId: string }) {
  return <ToolMessage item={tool.start} endItem={tool.end} piSessionId={piSessionId} />;
}

function AssistantContents({
  message,
  tools,
  piSessionId,
  streaming = false,
  thinkingStreaming = false,
}: {
  message?: ChatTimelineMessage;
  tools: ConversationToolBlock[];
  piSessionId: string;
  streaming?: boolean;
  thinkingStreaming?: boolean;
}) {
  const content: ReactNode[] = [];
  for (const [index, block] of buildConversationContentParts(message, tools).entries()) {
    if (block.type === "text" && block.text.trim()) {
      content.push(
        <MarkdownContent key={`text:${index}`} content={block.text} streaming={streaming} />,
      );
    } else if (block.type === "thinking" && (block.thinking.trim() || streaming)) {
      content.push(
        <ThinkingBlock
          key={`thinking:${index}`}
          content={block.thinking}
          streaming={thinkingStreaming}
        />,
      );
    } else if (block.type === "tool") {
      content.push(
        <ToolBlock
          key={`tool:${index}:${block.tool.start.toolUseId}`}
          tool={block.tool}
          piSessionId={piSessionId}
        />,
      );
    }
  }
  return <>{content}</>;
}

type ChatMessageRowProps = {
  row: ConversationRow;
  piSessionId: string;
  isSessionBusy?: boolean;
  onPrune?: (piEntryId: string) => void;
  onFork?: (piEntryId: string) => void;
};

function UserMessageRow({
  message,
  onPrune,
  onFork,
}: {
  message: ChatTimelineMessage;
  onPrune?: (piEntryId: string) => void;
  onFork?: (piEntryId: string) => void;
}) {
  const [copyTarget, setCopyTarget] = useState<HTMLElement | null>(null);
  const hook = message.source === "hook";
  return (
    <>
      {message.compaction && (
        <div className="mx-4 mt-8 mb-1 flex items-center gap-2 text-[10px] tracking-wide text-text-muted uppercase">
          <hr className="flex-1 border-t border-border" />
          <span>Context compacted</span>
          <hr className="flex-1 border-t border-border" />
        </div>
      )}
      <div
        className={`group/user-message mr-4 mb-2 ml-2 flex justify-start ${message.compaction ? "mt-1" : "mt-8"}`}
      >
        <div className="relative">
          <div
            ref={setCopyTarget}
            className={`user-message-container rounded-xl border py-2 pr-8 pl-4 text-text ${hook ? "border-border bg-background-selected" : "border-border-pop bg-background-pop"}`}
          >
            {message.content && <span className="whitespace-pre-wrap">{message.content}</span>}
            {Boolean(message.images?.length) && (
              <div className={`flex flex-wrap gap-2 ${message.content ? "mt-2" : ""}`}>
                {message.images?.map((image, index) => (
                  <img
                    key={`${image.mimeType}:${index}`}
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt="Attached image"
                    className="max-h-[240px] max-w-[240px] rounded-lg object-contain"
                  />
                ))}
              </div>
            )}
          </div>
          <MessageCopyButton text={message.content} target={copyTarget} />
          {message.piEntryId && onFork && onPrune && (
            <MessageActionsMenu
              onFork={() => onFork(message.piEntryId!)}
              onPrune={() => onPrune(message.piEntryId!)}
            />
          )}
        </div>
      </div>
    </>
  );
}

function AssistantMessageRow({
  row,
  piSessionId,
  isSessionBusy = false,
}: Pick<ChatMessageRowProps, "row" | "piSessionId" | "isSessionBusy">) {
  const message = row.message;
  const [copyTarget, setCopyTarget] = useState<HTMLElement | null>(null);
  return (
    <div className="relative">
      <div ref={setCopyTarget} className="mt-2 flex flex-col gap-1 px-4 pr-6">
        <AssistantContents message={message} tools={row.tools} piSessionId={piSessionId} />
      </div>
      {row.copyText && (!isSessionBusy || !row.isCurrentTurn) && (
        <MessageCopyButton text={row.copyText} target={copyTarget} />
      )}
    </div>
  );
}

export function ChatMessageRow({
  row,
  piSessionId,
  isSessionBusy = false,
  onPrune,
  onFork,
}: ChatMessageRowProps) {
  return row.message?.role === "user" ? (
    <UserMessageRow message={row.message} onPrune={onPrune} onFork={onFork} />
  ) : (
    <AssistantMessageRow row={row} piSessionId={piSessionId} isSessionBusy={isSessionBusy} />
  );
}

function StreamingAssistantContents({
  streaming,
  piSessionId,
}: {
  streaming: ConversationStreamingState;
  piSessionId: string;
}) {
  const message: ChatTimelineMessage = {
    id: streaming.messageId,
    kind: "message",
    role: "assistant",
    content: streaming.text,
    blocks: [
      ...(streaming.thinking || streaming.thinkingActive
        ? [{ type: "thinking" as const, thinking: streaming.thinking }]
        : []),
      ...(streaming.text ? [{ type: "text" as const, text: streaming.text }] : []),
    ],
    createdAt: new Date(0).toISOString(),
  };
  return (
    <div className="relative">
      <div className="mt-2 flex flex-col gap-1 px-4 pr-6">
        <AssistantContents
          message={message}
          tools={[]}
          piSessionId={piSessionId}
          streaming
          thinkingStreaming={streaming.thinkingActive}
        />
      </div>
    </div>
  );
}

export function StreamingAssistantRow({ piSessionId }: { piSessionId: string }) {
  const streaming = useConversationStreaming(piSessionId);
  if (!streaming) return null;
  return (
    <StreamingAssistantContents
      key={streaming.messageId}
      streaming={streaming}
      piSessionId={piSessionId}
    />
  );
}
