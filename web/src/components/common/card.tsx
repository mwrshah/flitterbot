import type { HTMLAttributes } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { cn } from "~/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  useWhyDidYouRender("Card", { className });
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  useWhyDidYouRender("CardHeader", { className });
  return <div className={cn("px-5 pt-5 pb-0", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  useWhyDidYouRender("CardTitle", { className });
  return (
    <div
      role="heading"
      aria-level={2}
      className={cn("text-sm font-semibold", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  useWhyDidYouRender("CardContent", { className });
  return <div className={cn("px-5 pb-5 pt-3", className)} {...props} />;
}
