import { type Ref, memo, useMemo } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { SkillListItem } from "~/lib/types";
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from "~/components/ui/command";

type SkillPickerProps = {
  open: boolean;
  filter: string;
  skills: SkillListItem[];
  selectedValue: string;
  onSelectedValueChange: (value: string) => void;
  onSelect: (skillName: string) => void;
  onClose: () => void;
  caretLeft?: number;
  commandRef?: Ref<HTMLDivElement>;
};

export const SkillPicker = memo(function SkillPicker({
  open,
  filter,
  skills,
  selectedValue,
  onSelectedValueChange,
  onSelect,
  onClose: _onClose,
  caretLeft,
  commandRef,
}: SkillPickerProps) {
  useWhyDidYouRender("SkillPicker", {
    open,
    filter,
    skills,
    selectedValue,
    onSelectedValueChange,
    onSelect,
  });
  const filtered = useMemo(() => {
    if (!filter) return skills;
    const lower = filter.toLowerCase();
    return skills.filter((s) => s.name.toLowerCase().includes(lower));
  }, [skills, filter]);

  if (!open || skills.length === 0) return null;

  return (
    <div className="absolute bottom-full mb-1 w-80 z-50" style={{ left: caretLeft ?? 0 }}>
      <Command
        ref={commandRef}
        value={selectedValue}
        onValueChange={onSelectedValueChange}
        shouldFilter={false}
        loop
        className="rounded-lg border border-border bg-background shadow-lg"
      >
        <CommandList className="max-h-48 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <CommandEmpty className="px-3 py-2 text-sm text-muted-foreground">
              No matching skills
            </CommandEmpty>
          )}
          {filtered.map((skill) => (
            <CommandItem
              key={skill.name}
              value={skill.name}
              onSelect={() => onSelect(skill.name)}
              className="flex items-baseline gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer data-[selected=true]:bg-muted"
            >
              <span className="font-mono text-foreground shrink-0">/{skill.name}</span>
              <span className="text-xs text-muted-foreground truncate">{skill.description}</span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  );
});
