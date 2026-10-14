import { useId, type InputHTMLAttributes, type Ref } from "react";

export interface RadioOptionProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className" | "aria-describedby"
> {
  readonly label: string;
  /** Language of the label when it differs from the page, such as "Nederlands" on an English page. */
  readonly labelLang?: string;
  /** Helper text under the label, linked to the radio button. */
  readonly description?: string;
  readonly ref?: Ref<HTMLInputElement>;
}

/** A native radio button with its visible label; the whole row is the click target. */
export function RadioOption({ label, labelLang, description, ref, ...rest }: RadioOptionProps) {
  const descriptionId = useId();
  const row = (
    <label className="flex min-h-10 cursor-pointer items-center gap-3 text-body text-fg">
      <input
        type="radio"
        ref={ref}
        aria-describedby={description ? descriptionId : undefined}
        className="size-5 shrink-0 cursor-pointer accent-accent"
        {...rest}
      />
      <span lang={labelLang}>{label}</span>
    </label>
  );
  if (!description) return row;
  // The hint stays outside the label, so it describes the option without becoming its name.
  return (
    <div>
      {row}
      <p id={descriptionId} className="-mt-1 mb-1 ps-8 text-helper text-fg-muted">
        {description}
      </p>
    </div>
  );
}
