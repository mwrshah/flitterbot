import { memo, type Ref } from "react";
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
};

export const SkillPicker = memo(function SkillPicker({
  open,
  filter,
  skills,
  onSelect,
  caretLeft,
  commandRef,
}: SkillPickerProps) {
  useWhyDidYouRender("SkillPicker", {
    open,
    filter,
    skills,
    onSelect,
  });

  if (!open || skills.length === 0) return null;

  return (
    <div className="absolute bottom-full mb-1 w-80 z-50" style={{ left: caretLeft ?? 0 }}>
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
              <span className="font-mono text-foreground shrink-0">/{skill.name}</span>
              <span className="text-xs text-muted-foreground truncate">{skill.description}</span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  );
});
