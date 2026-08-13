import {
  type KeyboardEvent,
  memo,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CaretPickerPositioner } from "@/components/common/caret-picker-positioner";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import type { SkillPickerItem } from "@/lib/types";

type SkillPickerProps = {
  open: boolean;
  items: SkillPickerItem[];
  onSelect: (skill: SkillPickerItem) => void;
  onEscape?: () => void;
  caretLeft?: number;
  commandRef?: Ref<HTMLDivElement>;
};

export const SkillPicker = memo(function SkillPicker({
  open,
  items,
  onSelect,
  onEscape,
  caretLeft,
  commandRef,
}: SkillPickerProps) {
  useWhyDidYouRender("SkillPicker", {
    open,
    items,
    onSelect,
    onEscape,
    caretLeft,
  });

  const [selectedValue, setSelectedValue] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    setSelectedValue(items[0]?.name ?? "");
    const list = pickerRef.current?.querySelector<HTMLElement>("[cmdk-list-sizer]")?.parentElement;
    if (list) list.scrollTop = 0;
  }, [open, items]);

  useEffect(() => {
    if (!selectedValue) return;
    requestAnimationFrame(() => {
      const el = pickerRef.current?.querySelector<HTMLElement>("[data-selected=true]");
      el?.scrollIntoView({ block: "nearest" });
    });
  }, [selectedValue]);

  const handleCommandKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || !onEscape) return;
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    },
    [onEscape],
  );

  if (!open) return null;

  return (
    <CaretPickerPositioner ref={pickerRef} caretLeft={caretLeft}>
      <Command
        ref={commandRef}
        shouldFilter={false}
        loop
        value={selectedValue}
        onValueChange={setSelectedValue}
        onKeyDownCapture={handleCommandKeyDownCapture}
        className="rounded-lg border border-border bg-background shadow-lg"
      >
        <CommandList className="max-h-48 overflow-y-auto p-1">
          {items.length === 0 ? (
            <div className="px-3 py-2 text-sm text-text-muted">No matching skills</div>
          ) : (
            items.map((skill) => {
              const isCommand = skill.kind === "command";
              return (
                <CommandItem
                  key={skill.name}
                  value={skill.name}
                  onSelect={() => onSelect(skill)}
                  className="flex items-baseline gap-2 rounded-md px-3 py-1.5 text-sm cursor-pointer data-selected:bg-background-hover [&>svg]:!hidden"
                >
                  <span
                    className={`shrink-0 font-mono text-xs ${isCommand ? "font-semibold text-text-pop" : "text-text"}`}
                  >
                    /{skill.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
                    {skill.description}
                  </span>
                  <span
                    className={`shrink-0 text-[10px] uppercase tracking-wide ${isCommand ? "text-text-pop" : "text-text-muted"}`}
                  >
                    {isCommand ? "Command" : "Skill"}
                  </span>
                </CommandItem>
              );
            })
          )}
        </CommandList>
      </Command>
    </CaretPickerPositioner>
  );
});
