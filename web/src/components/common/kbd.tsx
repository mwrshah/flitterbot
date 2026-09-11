import { cn } from "cn";
import type { HTMLAttributes } from "react";

type KbdSize = "default" | "compact";

const sizeStyles: Record<KbdSize, string> = {
  default: "h-5 min-w-5 px-1.5 text-[10px]",
  compact: "h-4 min-w-4 px-1 text-[9px]",
};

export function ShortcutHint({
  label,
  collapseModifiers = false,
  actionText,
  actionActive = false,
  actionOnHover = false,
  actionKeycap = false,
  className,
  kbdSize = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  label: string;
  collapseModifiers?: boolean;
  actionText?: string;
  actionActive?: boolean;
  actionOnHover?: boolean;
  actionKeycap?: boolean;
  kbdSize?: KbdSize;
}) {
  const steps: string[] = [];
  for (const step of label.split(/\s+then\s+/i)) {
    const trimmed = step.trim();
    if (trimmed) steps.push(trimmed);
  }
  const showAction = Boolean(actionText);
  const keycapClassName = cn(
    "inline-flex shrink-0 items-center justify-center rounded-[4px] border border-border-muted bg-background-muted font-mono font-medium leading-none text-text-muted",
    sizeStyles[kbdSize],
  );

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
            <span className="inline-flex items-center gap-0.5">
              {step.split("+").map((key, keyIndex, keys) => (
                <kbd
                  key={key}
                  className={cn(
                    keycapClassName,
                    collapseModifiers &&
                      steps.length === 1 &&
                      keyIndex < keys.length - 1 &&
                      "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-hover/shortcut-hint:opacity-100 group-focus-within/shortcut-hint:opacity-100",
                  )}
                >
                  {key}
                </kbd>
              ))}
            </span>
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
