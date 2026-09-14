import { type PointerEvent, useEffect, useRef, useState } from "react";

export function usePointerRest(delay: number) {
  const [rested, setRested] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const clearTimer = () => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
  };

  useEffect(() => clearTimer, []);

  const startTimer = () => {
    if (rested) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      setRested(true);
    }, delay);
  };

  const onPointerEnter = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") startTimer();
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") return;
    if (timerRef.current !== undefined && event.movementX ** 2 + event.movementY ** 2 < 2) {
      return;
    }
    startTimer();
  };

  const onPointerLeave = () => {
    clearTimer();
    setRested(false);
  };

  return { rested, pointerProps: { onPointerEnter, onPointerMove, onPointerLeave } };
}
