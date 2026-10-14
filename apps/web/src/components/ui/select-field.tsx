import { useId, type Ref, type SelectHTMLAttributes } from "react";

import { cx } from "./cx";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectFieldProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "className" | "id" | "aria-describedby" | "children" | "multiple"
> {
  /** Visible label (spec: inputs have visible labels). */
  readonly label: string;
  /** Helper text under the label. */
  readonly description?: string;
  readonly options: readonly SelectOption[];
  readonly className?: string;
  readonly ref?: Ref<HTMLSelectElement>;
}

/**
 * A labelled native select: the browser supplies keyboard, screen-reader and touch behaviour.
 * Uncontrolled-friendly, so React Hook Form can register it (architecture.md §13).
 */
export function SelectField({
  label,
  description,
  options,
  className,
  ref,
  ...rest
}: SelectFieldProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-body font-medium text-fg">
        {label}
      </label>
      {description ? (
        <p id={descriptionId} className="text-helper text-fg-muted">
          {description}
        </p>
      ) : null}
      <select
        {...rest}
        ref={ref}
        id={id}
        aria-describedby={descriptionId}
        className={cx(
          "min-h-10 rounded-control border border-line-control bg-surface px-3 text-body text-fg",
          "transition-colors duration-(--md-duration-fast) ease-standard",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
