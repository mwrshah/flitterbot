import { useQuery } from "@tanstack/react-query";
import {
  type ClipboardEvent,
  type DragEvent,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { PathPicker } from "~/components/path-picker";
import { SkillPicker } from "~/components/skill-picker";
import { Button } from "~/components/common/button";
import { directoryCompletionsQueryOptions } from "~/lib/queries";
import type { DirectoryCompletionItem, ImageAttachment, SkillListItem } from "~/lib/types";

type MessageInputProps = {
  isSending: boolean;
  onSubmit: (text: string) => void;
  pendingImages: ImageAttachment[];
  onAddImages: (files: FileList | File[]) => void;
  onRemoveImage: (index: number) => void;
  skills?: SkillListItem[];
  placeholder?: string;
  rows?: number;
  helpText?: string;
};

export const MessageInput = memo(function MessageInput({
  isSending,
  onSubmit,
  pendingImages,
  onAddImages,
  onRemoveImage,
  skills,
  placeholder = "Message Pi…",
  rows = 2,
  helpText = "Enter to send · Shift+Enter for newline · Type / for skills · @ for paths",
}: MessageInputProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");
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

  // Debounce the path filter before querying
  const [debouncedAtFilter, setDebouncedAtFilter] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedAtFilter(atPickerFilter), 150);
    return () => clearTimeout(id);
  }, [atPickerFilter]);

  const { data: pathItems = [], isFetching: isPathFetching } = useQuery(
    directoryCompletionsQueryOptions(debouncedAtFilter, atPickerOpen),
  );

  // Refs for stable useCallback closures
  const draftRef = useRef(draft);
  const pickerOpenRef = useRef(pickerOpen);
  const atPickerOpenRef = useRef(atPickerOpen);
  const onSubmitRef = useRef(onSubmit);
  const onAddImagesRef = useRef(onAddImages);
  useEffect(() => {
    draftRef.current = draft;
    pickerOpenRef.current = pickerOpen;
    atPickerOpenRef.current = atPickerOpen;
    onSubmitRef.current = onSubmit;
    onAddImagesRef.current = onAddImages;
  });

  /**
   * Compute the pixel X position of a character index in the textarea,
   * relative to the container div, using the mirror-div technique.
   */
  const computeSlashLeft = useCallback((value: string, slashIdx: number) => {
    const textarea = textareaRef.current;
    const container = containerRef.current;
    if (!textarea || !container || slashIdx < 0) return;

    const style = window.getComputedStyle(textarea);
    const mirror = document.createElement("div");
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.fontFamily = style.fontFamily;
    mirror.style.fontSize = style.fontSize;
    mirror.style.fontWeight = style.fontWeight;
    mirror.style.letterSpacing = style.letterSpacing;
    mirror.style.lineHeight = style.lineHeight;
    mirror.style.paddingTop = style.paddingTop;
    mirror.style.paddingRight = style.paddingRight;
    mirror.style.paddingBottom = style.paddingBottom;
    mirror.style.paddingLeft = style.paddingLeft;
    mirror.style.width = `${textarea.offsetWidth}px`;
    mirror.style.boxSizing = "border-box";

    mirror.appendChild(document.createTextNode(value.slice(0, slashIdx)));
    const marker = document.createElement("span");
    marker.textContent = "\u200b"; // zero-width space marks the caret
    mirror.appendChild(marker);

    document.body.appendChild(mirror);
    const markerRect = marker.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    document.body.removeChild(mirror);

    const popoverWidth = 320; // w-80
    const maxLeft = container.offsetWidth - popoverWidth;
    setCaretLeft(Math.min(Math.max(0, markerRect.left - containerRect.left), maxLeft));
  }, []);

  /**
   * Detect a slash command token at the cursor position.
   * A slash trigger is "/" preceded by start-of-string or whitespace,
   * followed by zero or more non-whitespace chars up to the cursor.
   */
  const handleDraftChange = useCallback(
    (value: string) => {
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
      }
    },
    [skills, computeSlashLeft],
  );

  const handleSkillSelect = useCallback((name: string) => {
    const value = draftRef.current;
    const slashIdx = slashPositionRef.current;
    const cursor = textareaRef.current?.selectionStart ?? value.length;
    // Replace from the "/" through the current filter text with "/<name> "
    const before = value.slice(0, slashIdx);
    const after = value.slice(cursor);
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

  const handlePathSelect = useCallback((item: DirectoryCompletionItem) => {
    const value = draftRef.current;
    const atIdx = atPositionRef.current;
    const cursor = textareaRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, atIdx);
    const after = value.slice(cursor);
    // Directories: insert @path/ (no trailing space, keeps picker open for drill-down)
    // Files: insert @path (trailing space, closes picker)
    const isDir = item.kind === "directory";
    const inserted = `@${item.path}${isDir ? "" : " "}`;
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
  }, [handleDraftChange]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // When a picker is open, forward navigation keys to cmdk.
      // Tab is mapped to Enter so it accepts the highlighted item.
      const navKeys = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Home", "End"];
      if (pickerOpenRef.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          setPickerOpen(false);
          // Remove trigger text from "/" to cursor
          const pos = slashPositionRef.current;
          if (pos >= 0) {
            const value = draftRef.current;
            const cursor = textareaRef.current?.selectionStart ?? value.length;
            const newValue = value.slice(0, pos) + value.slice(cursor);
            setDraft(newValue);
            slashPositionRef.current = -1;
            requestAnimationFrame(() => {
              textareaRef.current?.setSelectionRange(pos, pos);
              textareaRef.current?.focus();
            });
          }
          return;
        }
        if (navKeys.includes(event.key)) {
          event.preventDefault();
          skillCommandRef.current?.dispatchEvent(
            new KeyboardEvent("keydown", { key: event.key === "Tab" ? "Enter" : event.key, bubbles: true }),
          );
          return;
        }
      }

      if (atPickerOpenRef.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          setAtPickerOpen(false);
          // Remove trigger text from "@" to cursor
          const pos = atPositionRef.current;
          if (pos >= 0) {
            const value = draftRef.current;
            const cursor = textareaRef.current?.selectionStart ?? value.length;
            const newValue = value.slice(0, pos) + value.slice(cursor);
            setDraft(newValue);
            atPositionRef.current = -1;
            requestAnimationFrame(() => {
              textareaRef.current?.setSelectionRange(pos, pos);
              textareaRef.current?.focus();
            });
          }
          return;
        }
        if (navKeys.includes(event.key)) {
          event.preventDefault();
          pathCommandRef.current?.dispatchEvent(
            new KeyboardEvent("keydown", { key: event.key === "Tab" ? "Enter" : event.key, bubbles: true }),
          );
          return;
        }
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const text = draftRef.current.trim();
        onSubmitRef.current(text);
        setDraft("");
      }
    },
    [],
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
      className="shrink-0 border-t border-border px-6 py-3"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(draftRef.current.trim()); setDraft(""); }} className="space-y-2">
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
        <div ref={containerRef} className="relative rounded-lg border border-border bg-background focus-within:ring-2 focus-within:ring-ring focus-within:border-transparent">
          <SkillPicker
            open={pickerOpen}
            filter={pickerFilter}
            skills={skills ?? []}
            onSelect={handleSkillSelect}
            caretLeft={caretLeft}
            commandRef={skillCommandRef}
          />
          <PathPicker
            open={atPickerOpen}
            items={pathItems}
            isFetching={isPathFetching}
            onSelect={handlePathSelect}
            caretLeft={caretLeft}
            commandRef={pathCommandRef}
          />
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={rows}
            placeholder={placeholder}
            className="w-full bg-transparent pl-10 pr-4 pt-3 pb-10 text-sm text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none"
          />
          {/* Attach button — top left */}
          <button
            type="button"
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
          {/* Toolbar — bottom right */}
          <div className="absolute right-2 bottom-2 flex items-center gap-1.5">
            <Button type="submit" size="sm" disabled={isSending || !canSend}>
              {isSending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground/40">{helpText}</p>
      </form>
    </div>
  );
});
