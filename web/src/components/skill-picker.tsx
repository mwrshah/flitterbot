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
import { CaretPickerPositioner } from "~/components/common/caret-picker-positioner";
import { Command, CommandItem, CommandList } from "~/components/ui/command";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { SkillListItem } from "~/lib/types";

type SkillPickerProps = {
  open: boolean;
  items: SkillListItem[];
  onSelect: (skill: SkillListItem) => void;
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
    </CaretPickerPositioner>
  );
});
