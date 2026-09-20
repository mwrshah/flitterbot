import { cn } from "cn";
import { type GroupProps, Panel, Group as ResizableGroup, Separator } from "react-resizable-panels";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";

const DEFAULT_RESIZE_TARGET_MINIMUM_SIZE = { coarse: 30, fine: 20 };

export { Panel };

export function Group({
  resizeTargetMinimumSize = DEFAULT_RESIZE_TARGET_MINIMUM_SIZE,
  ...props
}: GroupProps) {
  return <ResizableGroup resizeTargetMinimumSize={resizeTargetMinimumSize} {...props} />;
}

export function VerticalSeparator({ className }: { className?: string }) {
  useWhyDidYouRender("VerticalSeparator", { className });
  return (
    <Separator
      className={cn(
        "relative flex w-[2px] cursor-col-resize items-center justify-center bg-border-muted data-[separator=active]:z-20 data-[separator=active]:bg-border-pop",
        className,
      )}
    />
  );
}

export function HorizontalSeparator({ className }: { className?: string }) {
  useWhyDidYouRender("HorizontalSeparator", { className });
  return (
    <Separator
      className={cn(
        "relative flex h-[2px] cursor-row-resize items-center justify-center bg-border-muted data-[separator=active]:z-20 data-[separator=active]:bg-border-pop",
        className,
      )}
    />
  );
}
