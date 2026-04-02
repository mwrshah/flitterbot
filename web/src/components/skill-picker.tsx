import { memo, type Ref, type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { SkillListItem } from "~/lib/types";

type SkillPickerProps = {
  open: boolean;
  filter: string;
  skills: SkillListItem[];
  onSelect: (skillName: string) => void;
  caretLeft?: number;
  commandRef?: Ref<HTMLDivElement>;
  anchorRef: RefObject<HTMLDivElement | null>;
};

export const SkillPicker = memo(function SkillPicker({
  open,
  filter,
  skills,
  onSelect,
  caretLeft,
  commandRef,
  anchorRef,
}: SkillPickerProps) {
  useWhyDidYouRender("SkillPicker", {
    open,
    filter,
    skills,
    onSelect,
  });

  const pickerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const picker = pickerRef.current;
    if (!anchor || !picker) return;
    const rect = anchor.getBoundingClientRect();
    const pickerHeight = picker.offsetHeight;
    const top = Math.max(0, rect.top - pickerHeight - 4); // 4px gap (mb-1)
    const left = rect.left + (caretLeft ?? 0);
    setPos({ top, left });
  }, [anchorRef, caretLeft]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition, filter]);

  if (!open || skills.length === 0) return null;

  return createPortal(
    <div ref={pickerRef} className="fixed w-[28rem] z-50" style={{ top: pos.top, left: pos.left }}>
      <Command
        ref={commandRef}
        loop
        className="rounded-lg border border-border bg-background shadow-lg"
      >
        {/* Hidden input bridges the textarea filter into cmdk's internal search */}
        <div className="h-0 overflow-hidden">
          <CommandInput value={filter} readOnly tabIndex={-1} />
        </div>
        <CommandList className="max-h-48 overflow-y-auto p-1">
          <CommandEmpty className="px-3 py-2 text-sm text-muted-foreground">
            No matching skills
          </CommandEmpty>
          {skills.map((skill) => (
            <CommandItem
              key={skill.name}
              value={skill.name}
              onSelect={() => onSelect(skill.name)}
              className="flex items-baseline gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer data-[selected=true]:bg-muted"
            >
              <span className="font-mono text-xs text-foreground shrink-0">/{skill.name}</span>
              <span className="text-xs text-muted-foreground truncate">{skill.description}</span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>,
    document.body,
  );
});
