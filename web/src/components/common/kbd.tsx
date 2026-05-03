import type { HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-muted/60 px-1.5 font-mono text-[10px] font-medium leading-none text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function KbdGroup({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 whitespace-nowrap align-middle", className)}
      {...props}
    />
  );
}

export function ShortcutHint({
  label,
  className,
  kbdClassName,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  label: string;
  kbdClassName?: string;
}) {
  const steps = label
    .split(/\s+then\s+/i)
    .map((step) => step.trim())
    .filter(Boolean);

  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", className)} {...props}>
      {steps.map((step, index) => (
        <span key={`${step}:${index}`} className="inline-flex items-center gap-1">
          {index > 0 && <span className="text-[10px] text-muted-foreground/45">then</span>}
          <KbdGroup>
            {step.split("+").map((key) => (
              <Kbd key={key} className={kbdClassName}>
                {key}
              </Kbd>
            ))}
          </KbdGroup>
        </span>
      ))}
    </span>
  );
}
