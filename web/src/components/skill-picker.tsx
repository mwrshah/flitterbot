import { Command } from "cmdk";
import { useMemo } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { SkillListItem } from "~/lib/types";

type SkillPickerProps = {
  open: boolean;
  filter: string;
  skills: SkillListItem[];
  selectedValue: string;
  onSelectedValueChange: (value: string) => void;
  onSelect: (skillName: string) => void;
  onClose: () => void;
};

export function SkillPicker({
  open,
  filter,
  skills,
  selectedValue,
  onSelectedValueChange,
  onSelect,
  onClose: _onClose,
}: SkillPickerProps) {
  useWhyDidYouRender("SkillPicker", { open, filter, skills, selectedValue, onSelectedValueChange, onSelect });
  const filtered = useMemo(() => {
    if (!filter) return skills;
    const lower = filter.toLowerCase();
    return skills.filter((s) => s.name.toLowerCase().includes(lower));
  }, [skills, filter]);

  if (!open || skills.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 mb-1 w-80 z-50">
      <Command
        value={selectedValue}
        onValueChange={onSelectedValueChange}
        shouldFilter={false}
        className="rounded-lg border border-border bg-background shadow-lg"
      >
        <Command.List className="max-h-48 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <Command.Empty className="px-3 py-2 text-sm text-muted-foreground">
              No matching skills
            </Command.Empty>
          )}
          {filtered.map((skill) => (
            <Command.Item
              key={skill.name}
              value={skill.name}
              onSelect={() => onSelect(skill.name)}
              className="flex items-baseline gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer data-[selected=true]:bg-muted"
            >
              <span className="font-mono text-foreground shrink-0">/{skill.name}</span>
              <span className="text-xs text-muted-foreground truncate">{skill.description}</span>
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}
