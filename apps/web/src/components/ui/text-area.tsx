import { ErrorIcon } from "@madeora/icons";
import { useId, type Ref, type TextareaHTMLAttributes } from "react";

import { cx } from "./cx";

export interface TextAreaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "className" | "id" | "aria-describedby" | "aria-invalid"
> {
  /** Visible label (spec: inputs have visible labels). */
  readonly label: string;
  /** Helper text under the label. */
  readonly description?: string;
  /** Validation message. When set, the field is marked invalid and the message is linked to it. */
  readonly error?: string | undefined;
  readonly className?: string;
  readonly ref?: Ref<HTMLTextAreaElement>;
}

/**
 * A labelled native multi-line text field, the counterpart of `TextField` for longer writing.
 * Uncontrolled-friendly, so React Hook Form can register it (architecture.md §13).
 */
export function TextArea({
  label,
  description,
  error,
  required,
  className,
  ref,
  rows = 5,
  ...rest
}: TextAreaProps) {
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
      <textarea
        {...rest}
        ref={ref}
        id={id}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          "rounded-control border bg-surface px-3 py-2 text-body text-fg",
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
