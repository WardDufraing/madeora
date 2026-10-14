import type { InputHTMLAttributes } from "react";

export interface RadioOptionProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className"
> {
  readonly label: string;
  /** Language of the label when it differs from the page, such as "Nederlands" on an English page. */
  readonly labelLang?: string;
}

/** A native radio button with its visible label; the whole row is the click target. */
export function RadioOption({ label, labelLang, ...rest }: RadioOptionProps) {
  return (
    <label className="flex min-h-10 cursor-pointer items-center gap-3 text-body text-fg">
      <input type="radio" className="size-5 shrink-0 cursor-pointer accent-accent" {...rest} />
      <span lang={labelLang}>{label}</span>
    </label>
  );
}
