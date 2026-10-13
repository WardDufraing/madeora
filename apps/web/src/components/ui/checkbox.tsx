import { CheckIcon, ErrorIcon } from "@madeora/icons";
import { useId, type InputHTMLAttributes, type Ref } from "react";

import { cx } from "./cx";

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "id" | "type" | "aria-describedby" | "aria-invalid"
> {
  readonly label: string;
  readonly description?: string;
  readonly error?: string;
  readonly className?: string;
  readonly ref?: Ref<HTMLInputElement>;
}

/**
 * A native checkbox drawn with tokens. The whole row (box and label) is the click target, at
 * least 24px high (WCAG 2.5.8; spec: generous targets). The checked state shows a check mark,
 * not only a colour change.
 */
export function Checkbox({ label, description, error, className, ref, ...rest }: CheckboxProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <div className="flex min-h-6 items-start gap-3">
        <span className="relative mt-0.5 flex size-5 shrink-0">
          <input
            {...rest}
            ref={ref}
            id={id}
            type="checkbox"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={cx(
              "peer size-5 cursor-pointer appearance-none rounded-[0.375rem] border-2 bg-surface",
              "transition-colors duration-(--md-duration-fast) ease-standard",
              "checked:border-accent checked:bg-accent",
              "disabled:cursor-not-allowed disabled:opacity-60",
              error ? "border-danger" : "border-line-control",
            )}
          />
          <CheckIcon
            size="sm"
            className="pointer-events-none absolute inset-0.5 hidden text-on-accent peer-checked:block"
          />
        </span>
        <label htmlFor={id} className="cursor-pointer text-body text-fg">
          {label}
        </label>
      </div>
      {description ? (
        <p id={descriptionId} className="ps-8 text-helper text-fg-muted">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 ps-8 text-helper text-danger">
          <ErrorIcon size="sm" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
