import { layoutWithLines, prepareWithSegments } from "@chenglou/pretext";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { ArrowRightIcon, Loader2Icon, OctagonIcon, RotateCcwIcon } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "~/components/common/button";
import { ModelSelector } from "~/components/model-selector";
import { PathPicker } from "~/components/path-picker";
import { SkillPicker } from "~/components/skill-picker";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { registerComposerFocusTarget } from "~/lib/global-shortcuts";
import { directoryCompletionsQueryOptions, skillsQueryOptions } from "~/lib/queries";
import type { DirectoryCompletionItem, ImageAttachment } from "~/lib/types";
import { cn } from "~/lib/utils";

/** Module-level store: persists draft text per route across navigations. */
const draftStore = new Map<string, string>();

type MessageInputProps = {
  isSending: boolean;
  /** Submit handler — selected model is set server-side via the inline selector. */
  onSubmit: (text: string) => void;
  pendingImages: ImageAttachment[];
  onAddImages: (files: FileList | File[]) => void;
  onRemoveImage: (index: number) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  /** Stream ID — when set, enables fuzzy file search within the stream's repo. */
  streamId?: string;
  fillHeight?: boolean;
  /** Key into draftStore — when set, persists draft text across route navigations. */
  draftKey?: string;
  /** Show the model-selector popover-trigger left of the send button. Default: true. */
  showModelSelector?: boolean;
  /** Agent is generating — send button swaps to a stop-sign icon. */
  isSessionBusy?: boolean;
  /** Triggered when the user clicks the stop-sign while session is busy. */
  onInterrupt?: () => void;
  /** Interrupt request in flight — disables the stop button. */
  isInterruptPending?: boolean;
  /** When set, send button is replaced with a Reopen/Recover action.
   *  - 'closed' → stream itself was closed; label is "Reopen"
   *  - 'dead'   → stream is open but its pi-session ended/crashed; label is "Recover" */
  recoveryKind?: "closed" | "dead";
  /** Triggered when the user clicks the recovery action. */
  onRecover?: () => void;
  /** Recovery request in flight — disables the recovery button. */
  isRecoverPending?: boolean;
};

const rootRouteApi = getRouteApi("__root__");

export const MessageInput = memo(function MessageInput({
  isSending,
  onSubmit,
  pendingImages,
  onAddImages,
  onRemoveImage,
  placeholder = "Press i to jump here · / for skills · @ for paths",
  rows = 2,
  autoFocus = false,
  streamId,
  fillHeight = false,
  draftKey,
  showModelSelector = true,
  isSessionBusy = false,
  onInterrupt,
  isInterruptPending = false,
  recoveryKind,
  onRecover,
  isRecoverPending = false,
}: MessageInputProps) {
  useWhyDidYouRender("MessageInput", { isSending, pendingImages, placeholder });
  // Skills list (built-in commands + server skills) comes pre-merged from
  // skillsQueryOptions and is prefetched in the root loader, so this read is
  // synchronous on first render after app boot.
  const { apiClient } = rootRouteApi.useRouteContext();
  const { data: skills } = useQuery(skillsQueryOptions(apiClient));
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draftKeyRef = useRef(draftKey);
  const [draft, setDraft] = useState(() => (draftKey ? (draftStore.get(draftKey) ?? "") : ""));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState("");
  const [caretLeft, setCaretLeft] = useState(0);
  // Track the position of the "/" that triggered the picker
  const slashPositionRef = useRef<number>(-1);
  const skillCommandRef = useRef<HTMLDivElement>(null);

  // @ path picker state (parallel to slash picker)
  const [atPickerOpen, setAtPickerOpen] = useState(false);
  const [atPickerFilter, setAtPickerFilter] = useState("");
  const pathCommandRef = useRef<HTMLDivElement>(null);
  const atPositionRef = useRef<number>(-1);
  const tildeExpandedRef = useRef(false);

  // Auto-focus textarea on mount when requested, cursor to end of any hydrated draft
  useEffect(() => {
    if (autoFocus) {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus();
        const len = textarea.value.length;
        if (len > 0) textarea.setSelectionRange(len, len);
      }
    }
  }, [autoFocus]);

  useEffect(() => {
    registerComposerFocusTarget(() => textareaRef.current?.focus());
    return () => registerComposerFocusTarget(null);
  }, []);

  // Debounce the path filter before querying
  const [debouncedAtFilter, setDebouncedAtFilter] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedAtFilter(atPickerFilter), 150);
    return () => clearTimeout(id);
  }, [atPickerFilter]);

  // Query directory completions for the @-picker. `keepPreviousData` in the
  // query options preserves the last list across refetches, so typing doesn't
  // flicker to empty. Cache is keyed per (query, streamId).
  const { data: pathResult } = useQuery(
    directoryCompletionsQueryOptions(debouncedAtFilter, atPickerOpen, { streamId }),
  );

  // Warm the cache for the empty query on mount so the first `@` has items
  // ready without a loading flash. Re-runs when streamId changes.
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClient.prefetchQuery(directoryCompletionsQueryOptions("", true, { streamId }));
  }, [queryClient, streamId]);

  // Refs for stable useCallback closures
  const draftRef = useRef(draft);
  const onSubmitRef = useRef(onSubmit);
  const onAddImagesRef = useRef(onAddImages);
  useEffect(() => {
    draftRef.current = draft;
    onSubmitRef.current = onSubmit;
    onAddImagesRef.current = onAddImages;
  });

  /** Close a picker on Escape: remove trigger text, reset position ref, refocus. */
  const closePicker = useCallback(
    (triggerPos: number, setOpen: (v: boolean) => void, posRef: React.MutableRefObject<number>) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      setOpen(false);
      const value = draftRef.current;
      const cursor = textarea.selectionStart ?? value.length;
      const newValue = value.slice(0, triggerPos) + value.slice(cursor);
      setDraft(newValue);
      posRef.current = -1;
      requestAnimationFrame(() => {
        textarea.setSelectionRange(triggerPos, triggerPos);
        textarea.focus();
      });
    },
    [],
  );

  /**
   * Compute the pixel X position of a character index in the textarea,
   * relative to the container div, using pretext's prepare + layout.
   */
  const computeSlashLeft = useCallback((value: string, slashIdx: number) => {
    const textarea = textareaRef.current;
    const container = containerRef.current;
    if (!textarea || !container || slashIdx < 0) return;

    const style = window.getComputedStyle(textarea);
    const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const paddingLeft = parseFloat(style.paddingLeft);
    const paddingRight = parseFloat(style.paddingRight);
    const contentWidth = textarea.offsetWidth - paddingLeft - paddingRight;
    const lineHeight = parseFloat(style.lineHeight);

    const textBeforeTrigger = value.slice(0, slashIdx);
    const prepared = prepareWithSegments(textBeforeTrigger, font, { whiteSpace: "pre-wrap" });
    const result = layoutWithLines(prepared, contentWidth, lineHeight);

    const lastLine = result.lines[result.lines.length - 1];
    const xOffset = lastLine ? lastLine.width : 0;

    const popoverWidth = 320; // w-80
    const maxLeft = container.offsetWidth - popoverWidth;
    setCaretLeft(Math.min(Math.max(0, paddingLeft + xOffset), maxLeft));
  }, []);

  /**
   * Detect a slash command token at the cursor position.
   * A slash trigger is "/" preceded by start-of-string or whitespace,
   * followed by zero or more non-whitespace chars up to the cursor.
   */
  const handleDraftChange = useCallback(
    (value: string) => {
      if (draftKeyRef.current) draftStore.set(draftKeyRef.current, value);
      setDraft(value);
      const cursor = textareaRef.current?.selectionStart ?? value.length;

      // Scan backwards from cursor to find a "/" trigger
      let slashIdx = -1;
      for (let i = cursor - 1; i >= 0; i--) {
        const ch = value[i];
        if (ch === "/") {
          if (i === 0 || /\s/.test(value[i - 1]!)) {
            slashIdx = i;
          }
          break;
        }
        if (/\s/.test(ch!)) break;
      }

      // Scan backwards from cursor to find an "@" trigger
      // Unlike "/" scan, we do NOT stop at "/" characters (paths contain slashes)
      let atIdx = -1;
      for (let i = cursor - 1; i >= 0; i--) {
        const ch = value[i];
        if (ch === "@") {
          if (i === 0 || /\s/.test(value[i - 1]!)) {
            atIdx = i;
          }
          break;
        }
        if (/\s/.test(ch!)) break;
      }

      // Only one picker at a time: @ takes priority when both could match
      if (atIdx >= 0) {
        const filter = value.slice(atIdx + 1, cursor);

        // Auto-append "/" when user types @~ so the picker queries home dir contents
        // One-shot: skip if we already expanded ~ to ~/ this session
        if (filter === "~" && !tildeExpandedRef.current) {
          tildeExpandedRef.current = true;
          const newValue = `${value.slice(0, cursor)}/${value.slice(cursor)}`;
          const newCursor = cursor + 1;
          setDraft(newValue);
          atPositionRef.current = atIdx;
          computeSlashLeft(newValue, atIdx);
          setAtPickerOpen(true);
          setAtPickerFilter("~/");
          slashPositionRef.current = -1;
          setPickerOpen(false);
          requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(newCursor, newCursor);
          });
          return;
        }

        // Reset one-shot tilde flag when filter no longer starts with ~
        if (!filter.startsWith("~")) {
          tildeExpandedRef.current = false;
        }

        // Collapse ~// → ~/ when user's own "/" keystroke doubles the auto-inserted one
        if (filter.startsWith("~//")) {
          const extra = atIdx + 1 + 2; // position of the second slash
          const newValue = value.slice(0, extra) + value.slice(extra + 1);
          const newCursor = cursor - 1;
          setDraft(newValue);
          atPositionRef.current = atIdx;
          computeSlashLeft(newValue, atIdx);
          setAtPickerOpen(true);
          setAtPickerFilter(filter.slice(0, 2) + filter.slice(3));
          slashPositionRef.current = -1;
          setPickerOpen(false);
          requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(newCursor, newCursor);
          });
          return;
        }

        atPositionRef.current = atIdx;
        computeSlashLeft(value, atIdx);
        setAtPickerOpen(true);
        setAtPickerFilter(filter);
        // Close slash picker
        slashPositionRef.current = -1;
        setPickerOpen(false);
      } else if (slashIdx >= 0 && skills?.length) {
        const filter = value.slice(slashIdx + 1, cursor);
        slashPositionRef.current = slashIdx;
        computeSlashLeft(value, slashIdx);
        setPickerOpen(true);
        setPickerFilter(filter);
        // Close @ picker
        atPositionRef.current = -1;
        setAtPickerOpen(false);
      } else {
        slashPositionRef.current = -1;
        setPickerOpen(false);
        atPositionRef.current = -1;
        setAtPickerOpen(false);
        tildeExpandedRef.current = false;
      }
    },
    [skills, computeSlashLeft],
  );

  const handleSkillSelect = useCallback((name: string) => {
    const value = draftRef.current;
    const slashIdx = slashPositionRef.current;
    // Find end of the trigger token (non-whitespace run from trigger position)
    let tokenEnd = slashIdx + 1;
    while (tokenEnd < value.length && !/\s/.test(value[tokenEnd]!)) tokenEnd++;
    // Replace from the "/" through the full token with "/<name> "
    const before = value.slice(0, slashIdx);
    const after = value.slice(tokenEnd);
    const inserted = `/${name} `;
    const newValue = before + inserted + after;
    setDraft(newValue);
    setPickerOpen(false);
    slashPositionRef.current = -1;
    // Restore cursor position after the inserted command
    const newCursor = before.length + inserted.length;
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(newCursor, newCursor);
      textareaRef.current?.focus();
    });
  }, []);

  const handlePathSelect = useCallback(
    (item: DirectoryCompletionItem) => {
      const value = draftRef.current;
      const atIdx = atPositionRef.current;
      // Find end of the trigger token (non-whitespace run from trigger position)
      let tokenEnd = atIdx + 1;
      while (tokenEnd < value.length && !/\s/.test(value[tokenEnd]!)) tokenEnd++;
      const before = value.slice(0, atIdx);
      const after = value.slice(tokenEnd);
      // Directories: insert @path/ (no trailing space, keeps picker open for drill-down)
      // Files: insert @path (trailing space, closes picker)
      const isDir = item.kind === "directory";
      const inserted = `@${item.insertText}${isDir ? "" : " "}`;
      const newValue = before + inserted + after;
      setDraft(newValue);
      if (!isDir) {
        setAtPickerOpen(false);
        atPositionRef.current = -1;
      }
      const newCursor = before.length + inserted.length;
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(newCursor, newCursor);
        textareaRef.current?.focus();
        // For directories, re-trigger the change handler so the picker refetches
        if (isDir) {
          handleDraftChange(newValue);
        }
      });
    },
    [handleDraftChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        if (slashPositionRef.current >= 0) {
          event.preventDefault();
          closePicker(slashPositionRef.current, setPickerOpen, slashPositionRef);
        } else if (atPositionRef.current >= 0) {
          event.preventDefault();
          closePicker(atPositionRef.current, setAtPickerOpen, atPositionRef);
        } else {
          // No picker open — defocus the input
          textareaRef.current?.blur();
        }
        return;
      }

      // Ctrl+W / Ctrl+Backspace: backward-kill-word
      if (
        event.ctrlKey &&
        (event.key === "w" || event.key === "Backspace") &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        const value = draftRef.current;
        const cursor = textareaRef.current?.selectionStart ?? value.length;
        if (cursor === 0) return;
        let i = cursor;
        const isDelim = (ch: string) => ch === "/" || ch === "@";
        // Skip whitespace before cursor
        const beforeWS = i;
        while (i > 0 && /\s/.test(value[i - 1]!)) i--;
        const skippedWhitespace = i < beforeWS;
        if (i > 0 && isDelim(value[i - 1]!)) {
          if (skippedWhitespace) {
            // Whitespace separated cursor from delimiter — eat delimiter(s) but stop before the word
            while (i > 0 && isDelim(value[i - 1]!)) i--;
          } else {
            // Cursor was right next to delimiter — eat it and the word before it
            while (i > 0 && isDelim(value[i - 1]!)) i--;
            while (i > 0 && !/\s/.test(value[i - 1]!) && !isDelim(value[i - 1]!)) i--;
          }
        } else {
          // Skip word characters, stopping at whitespace or delimiters
          while (i > 0 && !/\s/.test(value[i - 1]!) && !isDelim(value[i - 1]!)) i--;
        }
        const newValue = value.slice(0, i) + value.slice(cursor);
        handleDraftChange(newValue);
        requestAnimationFrame(() => {
          textareaRef.current?.setSelectionRange(i, i);
        });
        return;
      }

      // Ctrl+L: clear input (terminal-style)
      if (
        event.ctrlKey &&
        event.key === "l" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        handleDraftChange("");
        return;
      }

      // When a picker is open, forward navigation keys to cmdk.
      // Tab is mapped to Enter so it accepts the highlighted item.
      // Use position refs (synchronously set) instead of state-synced open refs.
      const navKeys = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Home", "End"];
      if (slashPositionRef.current >= 0 && navKeys.includes(event.key)) {
        event.preventDefault();
        skillCommandRef.current?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: event.key === "Tab" ? "Enter" : event.key,
            bubbles: true,
          }),
        );
        return;
      }
      if (atPositionRef.current >= 0 && navKeys.includes(event.key)) {
        event.preventDefault();
        pathCommandRef.current?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: event.key === "Tab" ? "Enter" : event.key,
            bubbles: true,
          }),
        );
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const text = draftRef.current.trim();
        onSubmitRef.current(text);
        setDraft("");
        if (draftKeyRef.current) draftStore.delete(draftKeyRef.current);
      }
    },
    [closePicker, handleDraftChange],
  );

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length) {
      event.preventDefault();
      onAddImagesRef.current(imageFiles);
    }
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer?.files?.length) {
      onAddImagesRef.current(Array.from(event.dataTransfer.files));
    }
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  const canSend = draft.trim() || pendingImages.length > 0;

  return (
    <div
      className={cn(
        "border-t border-border",
        fillHeight ? "h-full flex flex-col min-h-0" : "shrink-0",
      )}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(draftRef.current.trim());
          setDraft("");
          if (draftKeyRef.current) draftStore.delete(draftKeyRef.current);
        }}
        className={cn(fillHeight && "flex-1 flex flex-col min-h-0 h-full")}
      >
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt="Pending attachment"
                  className="w-16 h-16 object-cover rounded-lg border border-border"
                />
                <button
                  type="button"
                  onClick={() => onRemoveImage(i)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) onAddImages(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
        <div
          ref={containerRef}
          className={cn(
            "relative bg-background focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring",
            fillHeight ? "flex-1 flex flex-col min-h-0" : "h-full",
          )}
        >
          <SkillPicker
            open={pickerOpen}
            filter={pickerFilter}
            skills={skills ?? []}
            onSelect={handleSkillSelect}
            caretLeft={caretLeft}
            commandRef={skillCommandRef}
            anchorRef={containerRef}
          />
          <PathPicker
            open={atPickerOpen}
            items={pathResult?.items ?? []}
            onSelect={handlePathSelect}
            caretLeft={caretLeft}
            commandRef={pathCommandRef}
            anchorRef={containerRef}
            fuzzy
          />
          <textarea
            ref={textareaRef}
            tabIndex={-1}
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={fillHeight ? undefined : rows}
            placeholder={placeholder}
            className={cn(
              "w-full bg-transparent pl-10 pr-4 pt-3 text-sm text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none",
              fillHeight && "flex-1 min-h-0",
            )}
          />
          {/* Attach button — top left */}
          <button
            type="button"
            tabIndex={-1}
            onClick={() => fileInputRef.current?.click()}
            className="absolute left-2.5 top-3.5 text-muted-foreground/60 hover:text-foreground transition-colors rounded p-0.5"
            title="Attach image"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
          </button>
          {/* Toolbar — bottom right. Model selector sits immediately left of
              the send button so "which model am I about to invoke" is always
              visible without stealing focus from the composer. */}
          <div className="absolute right-2 bottom-2 flex items-center gap-1.5">
            {showModelSelector && <ModelSelector disabled={isSending} />}
            {recoveryKind ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isRecoverPending || !onRecover}
                onClick={() => onRecover?.()}
                className="h-10 sm:h-7 px-3"
              >
                <RotateCcwIcon className="w-4 h-4" />
                <span>
                  {isRecoverPending
                    ? recoveryKind === "dead"
                      ? "Recovering…"
                      : "Reopening…"
                    : recoveryKind === "dead"
                      ? "Recover"
                      : "Reopen"}
                </span>
              </Button>
            ) : isSessionBusy ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={isInterruptPending || !onInterrupt}
                onClick={() => onInterrupt?.()}
                className="h-10 w-10 sm:h-7 sm:w-auto sm:px-3"
                title="Stop"
              >
                <OctagonIcon className="w-4 h-4 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={isSending || !canSend}
                className="h-10 w-10 sm:h-7 sm:w-auto sm:px-3"
              >
                {isSending ? (
                  <Loader2Icon className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowRightIcon className="w-4 h-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
});
