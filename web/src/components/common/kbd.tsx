import type { HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

type KbdSize = "default" | "compact";
type KbdTone = "default" | "sidebar";

const sizeStyles: Record<KbdSize, string> = {
  default: "h-5 min-w-5 rounded-md px-1.5 text-[10px]",
  compact: "h-4 min-w-4 rounded px-1 text-[9px]",
};

const toneStyles: Record<KbdTone, string> = {
  default: "text-muted-foreground",
  sidebar: "text-sidebar-foreground/45",
};

type KbdProps = HTMLAttributes<HTMLElement> & {
  size?: KbdSize;
  tone?: KbdTone;
};

function Kbd({ className, size = "default", tone = "default", ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center border border-border bg-muted/60 font-mono font-medium leading-none",
        sizeStyles[size],
        toneStyles[tone],
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
  actionText = "Copied",
  actionActive = false,
  className,
  kbdClassName,
  kbdSize = "default",
  kbdTone = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  label: string;
  actionText?: string;
  actionActive?: boolean;
  kbdClassName?: string;
  kbdSize?: KbdSize;
  kbdTone?: KbdTone;
}) {
  const steps: string[] = [];
  for (const step of label.split(/\s+then\s+/i)) {
    const trimmed = step.trim();
    if (trimmed) steps.push(trimmed);
  }

  return (
    <span className={cn("inline-grid items-center whitespace-nowrap", className)} {...props}>
      <span
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center gap-1",
          actionActive && "invisible pointer-events-none",
        )}
        aria-hidden={actionActive}
      >
        {steps.map((step, index) => (
          <span key={step} className="inline-flex items-center gap-1">
            {index > 0 && <span className="text-[10px] text-muted-foreground/45">then</span>}
            <KbdGroup>
              {step.split("+").map((key) => (
                <Kbd key={key} size={kbdSize} tone={kbdTone} className={kbdClassName}>
                  {key}
                </Kbd>
              ))}
            </KbdGroup>
          </span>
        ))}
      </span>
      <span
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center text-[10px] text-muted-foreground/50",
          !actionActive && "invisible pointer-events-none",
        )}
        aria-hidden={!actionActive}
      >
        {actionText}
      </span>
    </span>
  );
}
