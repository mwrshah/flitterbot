import * as React from "react";
import { cn } from "~/lib/utils";

type ButtonVariant = "default" | "secondary" | "ghost" | "destructive";
type ButtonSize = "default" | "sm" | "icon";

const variantStyles: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground border border-border hover:bg-secondary/80",
  ghost: "text-muted-foreground hover:bg-accent/10 hover:text-foreground",
  destructive:
    "bg-destructive/15 text-destructive border border-destructive/30 hover:bg-destructive/25",
};

const sizeStyles: Record<ButtonSize, string> = {
  default: "h-9 px-4 py-2 text-sm",
  sm: "h-7 px-3 text-xs",
  icon: "h-8 w-8 p-0",
};

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "default", ...props },
  ref,
) {
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
});
