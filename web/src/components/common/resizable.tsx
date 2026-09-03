import { cn } from "cn";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";

export { Group as PanelGroup, Panel };

export function ResizeHandle({ className }: { className?: string }) {
  useWhyDidYouRender("ResizeHandle", { className });
  return (
    <Separator
      className={cn(
        "relative flex w-[2px] cursor-col-resize items-center justify-center bg-border-muted after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 data-[separator=active]:z-20 data-[separator=active]:bg-border-pop",
        className,
      )}
    />
  );
}

export function HorizontalResizeHandle({ className }: { className?: string }) {
  useWhyDidYouRender("HorizontalResizeHandle", { className });
  return (
    <Separator
      className={cn(
        "relative flex h-[2px] cursor-row-resize items-center justify-center bg-border-muted after:absolute after:inset-x-0 after:top-1/2 after:h-1 after:-translate-y-1/2 data-[separator=active]:z-20 data-[separator=active]:bg-border-pop",
        className,
      )}
    />
  );
}
