import { cn } from "cn";
import type { HTMLAttributes } from "react";

const keycapClassName =
  "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border border-border-muted bg-background-muted px-1 font-mono text-[9px] font-medium leading-none text-text-muted";

export function ShortcutHint({
  label,
  collapseModifiers = false,
  actionText,
  actionActive = false,
  actionOnHover = false,
  actionKeycap = false,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  label: string;
  collapseModifiers?: boolean;
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
            <span className="inline-flex items-center gap-0.5">
              {step.split("+").map((key, keyIndex, keys) => (
                <kbd
                  key={key}
                  className={cn(
                    keycapClassName,
                    collapseModifiers &&
                      steps.length === 1 &&
                      keyIndex < keys.length - 1 &&
                      "hidden group-hover:inline-flex group-focus-visible:inline-flex group-hover/shortcut-hint:inline-flex group-focus-within/shortcut-hint:inline-flex",
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
