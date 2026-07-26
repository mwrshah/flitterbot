import type * as React from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { cn } from "~/lib/utils";

type ButtonVariant = "default" | "subtle" | "selected" | "pop" | "danger";
type ButtonSize = "default" | "sm" | "icon" | "icon-sm";

const variantStyles: Record<ButtonVariant, string> = {
  default:
    "bg-background-contrast text-text-contrast hover:bg-background-contrast-muted hover:text-text-contrast-muted",
  subtle: "border border-border bg-background-muted text-text hover:bg-background-hover",
  selected: "border border-border bg-background-selected text-text",
  pop: "border border-border-pop bg-background-pop text-text hover:bg-background-hover",
  danger: "bg-status-crashed-muted text-status-crashed hover:bg-background-hover",
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
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop",
        "disabled:pointer-events-none disabled:opacity-50",
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      {...props}
    />
  );
}
