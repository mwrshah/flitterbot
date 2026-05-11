import { memo, type Ref, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Command, CommandItem, CommandList } from "~/components/ui/command";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { SkillListItem } from "~/lib/types";

type SkillPickerProps = {
  open: boolean;
  items: SkillListItem[];
  onSelect: (skill: SkillListItem) => void;
  caretLeft?: number;
  commandRef?: Ref<HTMLDivElement>;
  anchorRef: RefObject<HTMLDivElement | null>;
};

export const SkillPicker = memo(function SkillPicker({
  open,
  items,
  onSelect,
  caretLeft,
  commandRef,
  anchorRef,
}: SkillPickerProps) {
  useWhyDidYouRender("SkillPicker", {
    open,
    items,
    onSelect,
  });

  // Manual selection management (cmdk won't auto-select with shouldFilter={false})
  const [selectedValue, setSelectedValue] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const picker = pickerRef.current;
    if (!anchor || !picker) return;
    const rect = anchor.getBoundingClientRect();
    const pickerHeight = picker.offsetHeight;
    const top = Math.max(0, rect.top - pickerHeight - 4); // 4px gap (mb-1)
    const maxCaretLeft = Math.max(0, anchor.offsetWidth - picker.offsetWidth);
    const clampedCaretLeft = Math.min(Math.max(0, caretLeft ?? 0), maxCaretLeft);
    const left = rect.left + clampedCaretLeft;
    setPos((prev) => (prev.top === top && prev.left === left ? prev : { top, left }));
  }, [anchorRef, caretLeft]);

  // Reset selection to first item and scroll list to top whenever the picker
  // opens or the filtered set changes. Including `open` is required so that
  // reopening the picker (which leaves this component mounted but rebuilds the
  // DOM) re-syncs selection to the top of the fresh list.
  useEffect(() => {
    if (!open) return;
    setSelectedValue(items[0]?.name ?? "");
    const list = pickerRef.current?.querySelector<HTMLElement>("[cmdk-list-sizer]")?.parentElement;
    if (list) list.scrollTop = 0;
    requestAnimationFrame(updatePosition);
  }, [open, items, updatePosition]);

  // Keep the selected item in view as the user keyboard-navigates.
  useEffect(() => {
    if (!selectedValue) return;
    requestAnimationFrame(() => {
      const el = pickerRef.current?.querySelector<HTMLElement>("[data-selected=true]");
      el?.scrollIntoView({ block: "nearest" });
    });
  }, [selectedValue]);

  if (!open) return null;

  return createPortal(
    <div ref={pickerRef} className="fixed w-[28rem] z-50" style={{ top: pos.top, left: pos.left }}>
      <Command
        ref={commandRef}
        shouldFilter={false}
        loop
        value={selectedValue}
        onValueChange={setSelectedValue}
        className="rounded-lg border border-border bg-background shadow-lg"
      >
        <CommandList className="max-h-48 overflow-y-auto p-1">
          {items.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No matching skills</div>
          ) : (
            items.map((skill) => {
              const isCommand = skill.kind === "command";
              return (
                <CommandItem
                  key={skill.name}
                  value={skill.name}
                  onSelect={() => onSelect(skill)}
                  className="flex items-baseline gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer data-[selected=true]:bg-muted [&>svg]:!hidden"
                >
                  <span
                    className={`font-mono text-xs shrink-0 ${isCommand ? "text-primary font-semibold" : "text-foreground"}`}
                  >
                    /{skill.name}
                  </span>
                  <span className="flex-1 min-w-0 text-xs text-muted-foreground truncate">
                    {skill.description}
                  </span>
                  <span
                    className={`text-[10px] uppercase tracking-wide shrink-0 ${isCommand ? "text-primary" : "text-muted-foreground/60"}`}
                  >
                    {isCommand ? "Command" : "Skill"}
                  </span>
                </CommandItem>
              );
            })
          )}
        </CommandList>
      </Command>
    </div>,
    document.body,
  );
});
