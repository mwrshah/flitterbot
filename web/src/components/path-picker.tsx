import { memo, type Ref, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Command, CommandEmpty, CommandItem, CommandList } from "~/components/ui/command";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { DirectoryCompletionItem } from "~/lib/types";

type PathPickerProps = {
  open: boolean;
  items: DirectoryCompletionItem[];
  isFetching: boolean;
  onSelect: (item: DirectoryCompletionItem) => void;
  caretLeft?: number;
  commandRef?: Ref<HTMLDivElement>;
  anchorRef: RefObject<HTMLDivElement | null>;
  /** When true, display compact mixed search results with path as secondary text. */
  fuzzy?: boolean;
};

export const PathPicker = memo(function PathPicker({
  open,
  items,
  isFetching,
  onSelect,
  caretLeft,
  commandRef,
  anchorRef,
  fuzzy,
}: PathPickerProps) {
  useWhyDidYouRender("PathPicker", { open, items, isFetching, caretLeft, fuzzy });
  // shouldFilter={false} means cmdk won't auto-select on children change.
  // Manually reset selection to first item when server-filtered results arrive.
  const [selectedValue, setSelectedValue] = useState("");
  useEffect(() => {
    setSelectedValue(items[0]?.path ?? "");
  }, [items]);

  const pickerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const picker = pickerRef.current;
    if (!anchor || !picker) return;
    const rect = anchor.getBoundingClientRect();
    const pickerHeight = picker.offsetHeight;
    const top = Math.max(0, rect.top - pickerHeight - 4);
    const left = rect.left + (caretLeft ?? 0);
    setPos({ top, left });
  }, [anchorRef, caretLeft]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition, items]);

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
              {fuzzy ? (
                <>
                  <span className="shrink-0">{item.kind === "directory" ? "\u{1F4C1}" : "\u{1F4C4}"}</span>
                  <span className="font-mono text-xs text-foreground shrink-0">{item.name}</span>
                  <span className="text-xs text-muted-foreground truncate">{item.path}</span>
                </>
              ) : (
                <>
                  <span className="shrink-0">{item.kind === "directory" ? "\u{1F4C1}" : "\u{1F4C4}"}</span>
                  <span className="font-mono text-xs text-foreground shrink-0">{item.name}</span>
                  <span className="text-xs text-muted-foreground truncate">{item.path}</span>
                </>
              )}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>,
    document.body,
  );
});
