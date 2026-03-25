import { type ClipboardEvent, type DragEvent, memo, useCallback, useRef, useState } from "react";
import { SkillPicker } from "~/components/skill-picker";
import { Button } from "~/components/ui/button";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { DeliveryMode, ImageAttachment, SkillListItem } from "~/lib/types";

type MessageInputProps = {
  deliveryMode: DeliveryMode;
  onDeliveryModeChange: (mode: DeliveryMode) => void;
  isSending: boolean;
  onSubmit: (text: string, images?: ImageAttachment[]) => void;
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
  skills,
  placeholder = "Message Pi…",
  rows = 2,
  helpText = "Enter to send · Shift+Enter for newline · Type / for skills",
}: MessageInputProps) {
  useWhyDidYouRender("MessageInput", { deliveryMode, onDeliveryModeChange, isSending, onSubmit, skills, placeholder, rows, helpText });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState("");
  const [selectedSkill, setSelectedSkill] = useState("");

  const filteredSkills =
    skills?.filter((s) => {
      if (!pickerFilter) return true;
      return s.name.toLowerCase().includes(pickerFilter.toLowerCase());
    }) ?? [];

  const handleDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      const match = value.match(/^\/(\S*)$/);
      if (match && skills?.length) {
        setPickerOpen(true);
        setPickerFilter(match[1] ?? "");
        setSelectedSkill("");
      } else {
        setPickerOpen(false);
      }
    },
    [skills],
  );

  const handleSkillSelect = useCallback((name: string) => {
    setDraft(`/${name} `);
    setPickerOpen(false);
  }, []);

  function submit() {
    const text = draft.trim();
    const images = pendingImages.length ? [...pendingImages] : undefined;
    if (!text && !images?.length) return;
    setDraft("");
    setPendingImages([]);
    onSubmit(text || "(image)", images);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (pickerOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setPickerOpen(false);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (selectedSkill) {
          handleSkillSelect(selectedSkill);
        } else if (filteredSkills.length > 0) {
          handleSkillSelect(filteredSkills[0]!.name);
        }
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const currentIndex = filteredSkills.findIndex((s) => s.name === selectedSkill);
        let nextIndex: number;
        if (event.key === "ArrowDown") {
          nextIndex = currentIndex < filteredSkills.length - 1 ? currentIndex + 1 : 0;
        } else {
          nextIndex = currentIndex > 0 ? currentIndex - 1 : filteredSkills.length - 1;
        }
        if (filteredSkills[nextIndex]) {
          setSelectedSkill(filteredSkills[nextIndex]!.name);
        }
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
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
      addImageFiles(imageFiles);
    }
  }

  function addImageFiles(files: File[] | FileList) {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1];
        if (base64) {
          setPendingImages((prev) => [...prev, { data: base64, mimeType: file.type }]);
        }
      };
      reader.readAsDataURL(file);
    }
  }

  function removeImage(index: number) {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (event.dataTransfer?.files?.length) {
      addImageFiles(Array.from(event.dataTransfer.files));
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
  }

  function handleFormSubmit(event: React.FormEvent) {
    event.preventDefault();
    submit();
  }

  const canSend = draft.trim() || pendingImages.length > 0;

  return (
    <div
      className="shrink-0 border-t border-border px-6 py-3"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <form onSubmit={handleFormSubmit} className="space-y-2">
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
                  onClick={() => removeImage(i)}
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
            if (e.target.files?.length) addImageFiles(Array.from(e.target.files));
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
