import { cn } from "cn";
import { type HTMLAttributes, type PointerEvent, useEffect, useRef, useState } from "react";

const SHORTCUT_REST_DELAY_MS = 200;
const keycapClassName =
  "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border border-border-muted bg-background-muted px-1 font-mono text-[9px] font-medium leading-none text-text-muted";

type ShortcutKeysProps = {
  keys: string[];
  variant: "default" | "compact";
  expanded?: boolean;
};

function ShortcutKeys({ keys, variant, expanded = true }: ShortcutKeysProps) {
  return keys.map((key, keyIndex) => (
    <kbd
      key={key}
      className={cn(
        keycapClassName,
        variant === "compact" && "rounded-[5px]",
        variant === "compact" && keyIndex === keys.length - 1 && "lowercase",
        keyIndex < keys.length - 1 &&
          !expanded &&
          "hidden group-focus-visible:inline-flex group-focus-within/shortcut-hint:inline-flex",
      )}
    >
      {key}
    </kbd>
  ));
}

function RestExpandableShortcutKeys({ keys, variant }: ShortcutKeysProps) {
  const [expanded, setExpanded] = useState(false);
  const restTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const clearRestTimer = () => {
    if (restTimerRef.current !== undefined) clearTimeout(restTimerRef.current);
    restTimerRef.current = undefined;
  };

  useEffect(() => clearRestTimer, []);

  const startRestTimer = () => {
    if (expanded) return;
    clearRestTimer();
    restTimerRef.current = setTimeout(() => {
      restTimerRef.current = undefined;
      setExpanded(true);
    }, SHORTCUT_REST_DELAY_MS);
  };

  const handlePointerEnter = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.pointerType === "mouse") startRestTimer();
  };

  const handlePointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.pointerType !== "mouse") return;
    if (restTimerRef.current !== undefined && event.movementX ** 2 + event.movementY ** 2 < 2) {
      return;
    }
    startRestTimer();
  };

  const handlePointerLeave = () => {
    clearRestTimer();
    setExpanded(false);
  };

  return (
    <span
      className="inline-flex items-center gap-0.5"
      onPointerEnter={handlePointerEnter}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <ShortcutKeys keys={keys} variant={variant} expanded={expanded} />
    </span>
  );
}

export function ShortcutHint({
  label,
  variant = "default",
  actionText,
  actionActive = false,
  actionOnHover = false,
  actionKeycap = false,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  label: string;
  variant?: "default" | "compact";
  actionText?: string;
  actionActive?: boolean;
  actionOnHover?: boolean;
  actionKeycap?: boolean;
}) {
  const steps: string[] = [];
  for (const step of label.split(/\s+then\s+/i)) {
    const trimmed = step.trim();
    if (trimmed) steps.push(trimmed);
  }
  const showAction = Boolean(actionText);

  return (
    <span
      className={cn("group/shortcut-hint inline-grid items-center whitespace-nowrap", className)}
      {...props}
    >
      <span
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center gap-1",
          showAction && actionActive && "invisible pointer-events-none",
          showAction && actionOnHover && "group-hover:invisible group-focus-visible:invisible",
        )}
        aria-hidden={showAction && actionActive}
      >
        {steps.map((step, index) => (
          <span key={step} className="inline-flex items-center gap-1">
            {index > 0 && <span className="text-[10px] text-text-muted">then</span>}
            {variant === "compact" && steps.length === 1 && step.includes("+") ? (
              <RestExpandableShortcutKeys keys={step.split("+")} variant={variant} />
            ) : (
              <span className="inline-flex items-center gap-0.5">
                <ShortcutKeys keys={step.split("+")} variant={variant} />
              </span>
            )}
          </span>
        ))}
      </span>
      {showAction && (
        <span
          className={cn(
            "col-start-1 row-start-1 inline-flex items-center justify-self-start text-[10px] leading-none text-text-muted",
            actionKeycap && keycapClassName,
            !actionActive && "invisible pointer-events-none",
            actionOnHover && "group-hover:visible group-focus-visible:visible",
          )}
          aria-hidden={actionOnHover || !actionActive}
        >
          {actionText}
        </span>
      )}
    </span>
  );
}
