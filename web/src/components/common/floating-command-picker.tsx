import { Popover } from "@base-ui/react/popover";
import { forwardRef, type ReactNode, type RefObject } from "react";

export type FloatingCommandPickerPlacement = "top" | "bottom";

type FloatingCommandPickerProps = {
  anchorRef: RefObject<HTMLElement | null>;
  caretLeft?: number;
  preferredPlacement?: FloatingCommandPickerPlacement;
  children: ReactNode;
};

export const FloatingCommandPicker = forwardRef<HTMLDivElement, FloatingCommandPickerProps>(
  function FloatingCommandPicker(
    { anchorRef, caretLeft = 0, preferredPlacement = "top", children },
    ref,
  ) {
    return (
      <Popover.Root open>
        <Popover.Portal>
          <Popover.Positioner
            anchor={anchorRef}
            side={preferredPlacement}
            align="start"
            alignOffset={Math.max(0, caretLeft)}
            sideOffset={4}
            positionMethod="fixed"
            collisionAvoidance={{ side: "flip", align: "shift" }}
            data-inline-command-picker
            className="z-50 w-[min(28rem,var(--anchor-width))] max-w-[calc(100vw-1rem)]"
          >
            <Popover.Popup
              ref={ref}
              initialFocus={false}
              finalFocus={false}
              className="outline-none"
            >
              {children}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    );
  },
);
