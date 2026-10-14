import { ErrorIcon } from "@madeora/icons";
import { useId, type InputHTMLAttributes, type Ref } from "react";

import { cx } from "./cx";

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "id" | "aria-describedby" | "aria-invalid"
> {
  /** Visible label (spec: inputs have visible labels). */
  readonly label: string;
  /** Helper text under the label. */
  readonly description?: string;
  /** Validation message. When set, the field is marked invalid and the message is linked to it. */
  readonly error?: string | undefined;
  readonly className?: string;
  readonly ref?: Ref<HTMLInputElement>;
}

/**
 * A labelled native text input. Uncontrolled-friendly, so React Hook Form can register it
 * (architecture.md §13); the server validates again regardless.
 */
export function TextField({
  label,
  description,
  error,
  required,
  className,
  ref,
  type = "text",
  ...rest
}: TextFieldProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-body font-medium text-fg">
        {label}
        {required ? (
          <span aria-hidden="true" className="text-danger">
            {" *"}
          </span>
        ) : null}
      </label>
      {description ? (
        <p id={descriptionId} className="text-helper text-fg-muted">
          {description}
        </p>
      ) : null}
      <input
        {...rest}
        ref={ref}
        id={id}
        type={type}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          "min-h-10 rounded-control border bg-surface px-3 text-body text-fg",
          "placeholder:text-fg-muted transition-colors duration-(--md-duration-fast) ease-standard",
          "disabled:cursor-not-allowed disabled:opacity-60",
          error ? "border-danger" : "border-line-control",
        )}
      />
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-helper text-danger">
          <ErrorIcon size="sm" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
