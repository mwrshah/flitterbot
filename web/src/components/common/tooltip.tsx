import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cloneElement, type ReactElement, type ReactNode, useId } from "react";

export function Tooltip({
  content,
  children,
  side = "top",
}: {
  content: ReactNode;
  children: ReactElement<{ "aria-describedby"?: string }>;
  side?: TooltipPrimitive.Positioner.Props["side"];
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
        render={cloneElement(children, { "aria-describedby": describedBy })}
      />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={6} collisionPadding={8}>
          <TooltipPrimitive.Popup
            id={popupId}
            role="tooltip"
            className="max-h-[var(--available-height)] max-w-[min(24rem,var(--available-width))] overflow-y-auto rounded-md border border-border bg-background-pop px-2 py-1 text-xs text-text shadow-md whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
