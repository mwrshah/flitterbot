import type * as React from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { cn } from "~/lib/utils";

type ButtonVariant = "default" | "secondary" | "ghost" | "destructive" | "outline";
type ButtonSize = "default" | "sm" | "icon" | "icon-sm";

const variantStyles: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground border border-border hover:bg-secondary/80",
  ghost: "text-muted-foreground hover:bg-accent/10 hover:text-foreground",
  destructive:
    "bg-destructive/15 text-destructive border border-destructive/30 hover:bg-destructive/25",
  outline: "border border-border bg-background hover:bg-muted hover:text-foreground",
};

const sizeStyles: Record<ButtonSize, string> = {
  default: "h-9 px-4 py-2 text-sm",
  sm: "h-7 px-3 text-xs",
  icon: "size-8 p-0",
  "icon-sm": "size-7 p-0",
};

type ButtonProps = React.ComponentPropsWithRef<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  className,
  variant = "default",
  size = "default",
  ref,
  ...props
}: ButtonProps) {
  useWhyDidYouRender("Button", { className, variant, size });
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      {...props}
    />
  );
}
