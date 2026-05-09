import type * as React from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { cn } from "~/lib/utils";

export function Input({ className, ref, ...props }: React.ComponentPropsWithRef<"input">) {
  useWhyDidYouRender("Input", { className });
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
}
