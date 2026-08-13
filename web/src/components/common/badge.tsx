import type { HTMLAttributes } from "react";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import { cn } from "@/lib/utils";

type BadgeVariant = "info" | "ended" | "crashed" | "active" | "waiting";

const variantStyles: Record<BadgeVariant, string> = {
  info: "bg-status-info-muted text-status-info",
  ended: "bg-status-ended-muted text-status-ended",
  crashed: "bg-status-crashed-muted text-status-crashed",
  active: "bg-status-active-muted text-status-active",
  waiting: "bg-status-waiting-muted text-status-waiting",
};

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
};

export function Badge({ className, variant = "info", ...props }: BadgeProps) {
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
