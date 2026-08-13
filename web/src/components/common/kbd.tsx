import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type KbdSize = "default" | "compact";

const sizeStyles: Record<KbdSize, string> = {
  default: "h-5 min-w-5 rounded-md px-1.5 text-[10px]",
  compact: "h-4 min-w-4 rounded px-1 text-[9px]",
};

type KbdProps = HTMLAttributes<HTMLElement> & {
  size?: KbdSize;
};

function Kbd({ className, size = "default", ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center border border-border-muted bg-background-muted font-mono font-medium leading-none text-text-muted",
        sizeStyles[size],
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 whitespace-nowrap align-middle", className)}
      {...props}
    />
  );
}

export function ShortcutHint({
  label,
  actionText,
  actionActive = false,
  actionOnHover = false,
  actionKeycap = false,
  className,
  kbdClassName,
  kbdSize = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  label: string;
  actionText?: string;
  actionActive?: boolean;
  actionOnHover?: boolean;
  actionKeycap?: boolean;
  kbdClassName?: string;
  kbdSize?: KbdSize;
}) {
  const steps: string[] = [];
  for (const step of label.split(/\s+then\s+/i)) {
    const trimmed = step.trim();
    if (trimmed) steps.push(trimmed);
  }
  const showAction = Boolean(actionText);

  return (
    <span className={cn("inline-grid items-center whitespace-nowrap", className)} {...props}>
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
            <KbdGroup>
              {step.split("+").map((key) => (
                <Kbd key={key} size={kbdSize} className={kbdClassName}>
                  {key}
                </Kbd>
              ))}
            </KbdGroup>
          </span>
        ))}
      </span>
      {showAction && (
        <span
          className={cn(
            "col-start-1 row-start-1 inline-flex items-center text-[10px] text-text-muted",
            !actionActive && "invisible pointer-events-none",
            actionOnHover && "group-hover:visible group-focus-visible:visible",
          )}
          aria-hidden={actionOnHover || !actionActive}
        >
          {actionKeycap ? (
            <Kbd size={kbdSize} className={kbdClassName}>
              {actionText}
            </Kbd>
          ) : (
            actionText
          )}
        </span>
      )}
    </span>
  );
}
