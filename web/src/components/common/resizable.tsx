import { Group, Panel, Separator } from "react-resizable-panels";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { cn } from "~/lib/utils";

export { Group as PanelGroup, Panel };

export function ResizeHandle({ className }: { className?: string }) {
  useWhyDidYouRender("ResizeHandle", { className });
  return (
    <Separator
      className={cn(
        "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 data-[resize-handle-active]:bg-accent",
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
        "relative flex h-px items-center justify-center bg-border after:absolute after:inset-x-0 after:top-1/2 after:h-1 after:-translate-y-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 data-[resize-handle-active]:bg-accent",
        className,
      )}
    />
  );
}
