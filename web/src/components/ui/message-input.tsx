import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { SkillPicker } from "~/components/skill-picker";
import { Button } from "~/components/ui/button";
import type { DeliveryMode, ImageAttachment, SkillListItem } from "~/lib/types";

type MessageInputProps = {
  deliveryMode: DeliveryMode;
  onDeliveryModeChange: (mode: DeliveryMode) => void;
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
  deliveryMode,
  onDeliveryModeChange,
  isSending,
  onSubmit,
  pendingImages,
  onAddImages,
  onRemoveImage,
  skills,
  placeholder = "Message Pi…",
  rows = 2,
  helpText = "Enter to send · Shift+Enter for newline · Type / for skills",
}: MessageInputProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState("");
  const [selectedSkill, setSelectedSkill] = useState("");
  // Track the position of the "/" that triggered the picker
  const slashPositionRef = useRef<number>(-1);

  // Refs for stable useCallback closures
  const draftRef = useRef(draft);
  const pickerOpenRef = useRef(pickerOpen);
  const selectedSkillRef = useRef(selectedSkill);
  const onSubmitRef = useRef(onSubmit);
  const onAddImagesRef = useRef(onAddImages);
  useEffect(() => {
    draftRef.current = draft;
    pickerOpenRef.current = pickerOpen;
    selectedSkillRef.current = selectedSkill;
    onSubmitRef.current = onSubmit;
    onAddImagesRef.current = onAddImages;
  });

  const filteredSkills =
    skills?.filter((s) => {
      if (!pickerFilter) return true;
      return s.name.toLowerCase().includes(pickerFilter.toLowerCase());
    }) ?? [];

  const filteredSkillsRef = useRef(filteredSkills);
  useEffect(() => {
    filteredSkillsRef.current = filteredSkills;
  });

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
          // Valid trigger: at start of string or preceded by whitespace
          if (i === 0 || /\s/.test(value[i - 1]!)) {
            slashIdx = i;
          }
          break;
        }
        if (/\s/.test(ch!)) break; // hit whitespace before finding "/" — no trigger
      }
      if (slashIdx >= 0 && skills?.length) {
        const filter = value.slice(slashIdx + 1, cursor);
        slashPositionRef.current = slashIdx;
        setPickerOpen(true);
        setPickerFilter(filter);
        setSelectedSkill("");
      } else {
        slashPositionRef.current = -1;
        setPickerOpen(false);
      }
    },
    [skills],
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

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (pickerOpenRef.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          setPickerOpen(false);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const selected = selectedSkillRef.current;
          const filtered = filteredSkillsRef.current;
          if (selected) {
            handleSkillSelect(selected);
          } else if (filtered.length > 0) {
            handleSkillSelect(filtered[0]!.name);
          }
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const filtered = filteredSkillsRef.current;
          const selected = selectedSkillRef.current;
          const currentIndex = filtered.findIndex((s) => s.name === selected);
          let nextIndex: number;
          if (event.key === "ArrowDown") {
            nextIndex = currentIndex < filtered.length - 1 ? currentIndex + 1 : 0;
          } else {
            nextIndex = currentIndex > 0 ? currentIndex - 1 : filtered.length - 1;
          }
          if (filtered[nextIndex]) {
            setSelectedSkill(filtered[nextIndex]!.name);
          }
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
    [handleSkillSelect],
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
        <div className="relative rounded-lg border border-border bg-background focus-within:ring-2 focus-within:ring-ring focus-within:border-transparent">
          <SkillPicker
            open={pickerOpen}
            filter={pickerFilter}
            skills={skills ?? []}
            selectedValue={selectedSkill}
            onSelectedValueChange={setSelectedSkill}
            onSelect={handleSkillSelect}
            onClose={() => setPickerOpen(false)}
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
            <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => onDeliveryModeChange("followUp")}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  deliveryMode === "followUp"
                    ? "bg-background text-foreground shadow-sm font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Follow-up
              </button>
              <button
                type="button"
                onClick={() => onDeliveryModeChange("steer")}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  deliveryMode === "steer"
                    ? "bg-background text-foreground shadow-sm font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Steer
              </button>
            </div>
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
