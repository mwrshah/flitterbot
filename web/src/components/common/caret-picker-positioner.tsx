import { type CSSProperties, forwardRef, type ReactNode } from "react";

const PICKER_CLASS =
  "absolute bottom-full z-50 mb-1 w-[min(28rem,100%)] left-[min(var(--picker-left),calc(100%_-_min(28rem,100%)))]";

type PickerStyle = CSSProperties & Record<"--picker-left", string>;

type CaretPickerPositionerProps = {
  caretLeft?: number;
  children: ReactNode;
};

export const CaretPickerPositioner = forwardRef<HTMLDivElement, CaretPickerPositionerProps>(
  function CaretPickerPositioner({ caretLeft, children }, ref) {
    const style: PickerStyle = {
      "--picker-left": `${Math.max(0, caretLeft ?? 0)}px`,
    };

    return (
      <div ref={ref} className={PICKER_CLASS} style={style}>
        {children}
      </div>
    );
  },
);
