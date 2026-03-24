import * as React from "react";
import { cn } from "~/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground",
        "placeholder:text-muted-foreground/60",
        "focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
