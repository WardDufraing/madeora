"use client";

import { SpinnerIcon } from "@madeora/icons";
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";

import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /**
   * Shows a spinner and ignores clicks while an action runs. The button stays focusable and
   * keeps its label (announced as busy), so keyboard focus is not lost.
   */
  readonly loading?: boolean;
  /** Decorative icon before the label. */
  readonly icon?: ReactNode;
  readonly className?: string;
  readonly ref?: Ref<HTMLButtonElement>;
}

// Solid fills only (spec: no gradient treatments). Every accent colour comes from tokens.
const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed",
  secondary:
    "border border-line-control bg-surface text-fg hover:bg-accent-subtle active:bg-accent-subtle",
  ghost: "text-fg hover:bg-accent-subtle active:bg-accent-subtle",
  destructive: "bg-danger-solid text-on-danger hover:brightness-95 active:brightness-90",
};

const sizes: Record<ButtonSize, string> = {
  md: "min-h-10 px-4 text-body gap-2",
  sm: "min-h-8 px-3 text-helper gap-1.5",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  type = "button",
  disabled,
  onClick,
  className,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const inactive = loading || disabled === true;

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (loading) {
      // Also stops a submit button from submitting its form again.
      event.preventDefault();
      return;
    }
    onClick?.(event);
  }

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
      className={cx(
        "inline-flex items-center justify-center rounded-control font-medium",
        "transition-colors duration-(--md-duration-fast) ease-standard",
        sizes[size],
        variants[variant],
        inactive && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      {loading ? (
        <SpinnerIcon
          size={size === "sm" ? "sm" : "md"}
          className="animate-spin motion-reduce:animate-none"
        />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
