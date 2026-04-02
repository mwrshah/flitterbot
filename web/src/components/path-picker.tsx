import { prepareWithSegments, layoutWithLines } from "@chenglou/pretext";
import { memo, type Ref, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Command, CommandEmpty, CommandItem, CommandList } from "~/components/ui/command";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { DirectoryCompletionItem } from "~/lib/types";

function dirFromPath(path: string, name: string): string {
  if (path.endsWith("/" + name)) return path.slice(0, -(name.length + 1));
  if (path === name) return "";
  return path;
}

const DIR_FONT = '400 12px "Geist Variable", ui-sans-serif, system-ui, sans-serif';
const DIR_LINE_HEIGHT = 16;

function measureTextWidth(text: string, font: string): number {
  const prepared = prepareWithSegments(text, font, { whiteSpace: "pre-wrap" });
  const result = layoutWithLines(prepared, 9999, DIR_LINE_HEIGHT);
  return result.lines[0]?.width ?? 0;
}

function smartMiddleTruncate(dir: string, availableWidth: number, font: string): string {
  if (measureTextWidth(dir, font) <= availableWidth) return dir;

  const prefix = dir.slice(0, 2);
  const ellipsis = "\u2026";
  const prefixEllipsisWidth = measureTextWidth(prefix + ellipsis, font);

  // Binary search for longest tail that fits
  let lo = 1;
  let hi = dir.length - 2;
  let best = 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = prefix + ellipsis + dir.slice(-mid);
    if (measureTextWidth(candidate, font) <= availableWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // If even the minimal truncation doesn't fit, return what we can
  if (prefixEllipsisWidth > availableWidth) return prefix + ellipsis;

  return prefix + ellipsis + dir.slice(-best);
}

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
          {items.map((item) => {
            const dir = dirFromPath(item.path, item.name);
            const displayDir = dir ? smartMiddleTruncate(dir, 200, DIR_FONT) : "";
            return (
              <CommandItem
                key={item.path}
                value={item.path}
                onSelect={() => onSelect(item)}
                className="flex items-baseline gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer data-[selected=true]:bg-muted"
              >
                <span className="shrink-0">{item.kind === "directory" ? "\u{1F4C1}" : "\u{1F4C4}"}</span>
                <span className="font-mono text-xs text-foreground shrink-0">{item.name}</span>
                {displayDir && <span className="text-xs text-muted-foreground">{displayDir}</span>}
              </CommandItem>
            );
          })}
        </CommandList>
      </Command>
    </div>,
    document.body,
  );
});
