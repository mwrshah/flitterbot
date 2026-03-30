import type { HTMLAttributes } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { cn } from "~/lib/utils";

type BadgeVariant = "default" | "muted" | "error" | "success" | "warning";

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-accent/15 text-accent-foreground border-accent/25",
  muted: "bg-muted/60 text-muted-foreground border-border",
  error: "bg-destructive/15 text-destructive border-destructive/30",
  success: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  warning: "bg-amber-500/15 text-amber-400 border-amber-500/25",
};

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
};

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  useWhyDidYouRender("Badge", { className, variant });
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border",
        variantStyles[variant],
        className,
      )}
      {...props}
    />
  );
}
