import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cloneElement, type ReactElement, type ReactNode, useId } from "react";

export function Tooltip({
  content,
  children,
  delay,
  side = "top",
  sideOffset = 6,
}: {
  content: ReactNode;
  children: ReactElement<{ "aria-describedby"?: string }>;
  delay?: TooltipPrimitive.Trigger.Props<unknown>["delay"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
}) {
  const popupId = useId();
  const disabled = content == null || content === false || content === "";
  const descriptionId = children.props["aria-describedby"];
  const describedBy = disabled
    ? descriptionId
    : descriptionId
      ? `${descriptionId} ${popupId}`
      : popupId;
  return (
    <TooltipPrimitive.Root disabled={disabled}>
      <TooltipPrimitive.Trigger
        delay={delay}
        render={cloneElement(children, { "aria-describedby": describedBy })}
      />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} collisionPadding={8}>
          <TooltipPrimitive.Popup
            id={popupId}
            role="tooltip"
            className="max-h-[var(--available-height)] max-w-[min(24rem,var(--available-width))] overflow-y-auto rounded-md border border-border bg-background-muted px-2 py-1 text-xs text-text shadow-md whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
