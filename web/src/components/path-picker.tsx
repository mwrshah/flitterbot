import { type Ref, memo } from "react";
import type { DirectoryCompletionItem } from "~/lib/types";
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from "~/components/ui/command";

type PathPickerProps = {
  open: boolean;
  items: DirectoryCompletionItem[];
  isFetching: boolean;
  onSelect: (item: DirectoryCompletionItem) => void;
  onClose: () => void;
  caretLeft?: number;
  commandRef?: Ref<HTMLDivElement>;
};

export const PathPicker = memo(function PathPicker({
  open,
  items,
  isFetching,
  onSelect,
  onClose: _onClose,
  caretLeft,
  commandRef,
}: PathPickerProps) {
  if (!open) return null;

  return (
    <div className="absolute bottom-full mb-1 w-80 z-50" style={{ left: caretLeft ?? 0 }}>
      <Command
        ref={commandRef}
        shouldFilter={false}
        loop
        className="rounded-lg border border-border bg-background shadow-lg"
      >
        <CommandList className="max-h-48 overflow-y-auto p-1">
          {isFetching && items.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">Loading...</div>
          )}
          {!isFetching && items.length === 0 && (
            <CommandEmpty className="px-3 py-2 text-sm text-muted-foreground">
              No matching paths
            </CommandEmpty>
          )}
          {items.map((item) => (
            <CommandItem
              key={item.path}
              value={item.path}
              onSelect={() => onSelect(item)}
              className="flex items-baseline gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer data-[selected=true]:bg-muted"
            >
              <span className="shrink-0">{item.kind === "directory" ? "📁" : "📄"}</span>
              <span className="font-mono text-foreground shrink-0">{item.name}</span>
              <span className="text-xs text-muted-foreground truncate">{item.path}</span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  );
});
