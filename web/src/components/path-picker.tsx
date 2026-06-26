import { layoutWithLines, prepareWithSegments } from "@chenglou/pretext";
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
import { Command, CommandEmpty, CommandItem, CommandList } from "~/components/ui/command";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { DirectoryCompletionItem } from "~/lib/types";

function dirFromPath(path: string, name: string): string {
  const cleanPath = path.endsWith("/") ? path.slice(0, -1) : path;
  if (cleanPath.endsWith(`/${name}`)) return cleanPath.slice(0, -(name.length + 1));
  if (cleanPath === name) return "";
  return cleanPath;
}

const DIR_FONT = '400 12px "Geist Variable", ui-sans-serif, system-ui, sans-serif';
const DIR_LINE_HEIGHT = 16;

// ponytail: prefer CSS truncation before measuring text with a layout dependency.
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

  if (prefixEllipsisWidth > availableWidth) return prefix + ellipsis;

  return prefix + ellipsis + dir.slice(-best);
}

type PathPickerProps = {
  open: boolean;
  items: DirectoryCompletionItem[];
  onSelect: (item: DirectoryCompletionItem) => void;
  onEscape?: () => void;
  caretLeft?: number;
  commandRef?: Ref<HTMLDivElement>;
  fuzzy?: boolean;
};

export const PathPicker = memo(function PathPicker({
  open,
  items,
  onSelect,
  onEscape,
  caretLeft,
  commandRef,
  fuzzy,
}: PathPickerProps) {
  useWhyDidYouRender("PathPicker", { open, items, onEscape, caretLeft, fuzzy });
  const [selectedValue, setSelectedValue] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    setSelectedValue(items[0]?.path ?? "");
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
          {items.length === 0 && (
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
                className="!flex !flex-col !items-start gap-0 px-3 py-1.5 rounded-md text-sm cursor-pointer data-[selected=true]:bg-muted [&>svg]:!hidden"
              >
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0">
                    {item.kind === "directory" ? "\u{1F4C1}" : "\u{1F4C4}"}
                  </span>
                  <span className="font-mono text-xs text-foreground shrink-0">{item.name}</span>
                </span>
                {displayDir && (
                  <span className="text-xs text-muted-foreground pl-[calc(1em+0.5rem)]">
                    {displayDir}
                  </span>
                )}
              </CommandItem>
            );
          })}
        </CommandList>
      </Command>
    </CaretPickerPositioner>
  );
});
