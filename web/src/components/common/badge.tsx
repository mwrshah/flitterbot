import type { HTMLAttributes } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { cn } from "~/lib/utils";

type BadgeVariant = "default" | "muted" | "error" | "success" | "warning";

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-status-info-muted text-status-info",
  muted: "bg-status-ended-muted text-status-ended",
  error: "bg-status-crashed-muted text-status-crashed",
  success: "bg-status-active-muted text-status-active",
  warning: "bg-status-waiting-muted text-status-waiting",
};

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
};

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  useWhyDidYouRender("Badge", { className, variant });
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        variantStyles[variant],
        className,
      )}
      {...props}
    />
  );
}
