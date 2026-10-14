import { ErrorIcon, InfoIcon, SuccessIcon } from "@madeora/icons";
import type { ReactNode } from "react";

import { cx } from "@/components/ui/cx";

export interface FormAlertProps {
  readonly tone: "error" | "success" | "info";
  readonly children: ReactNode;
  /** Announce at once (results of an action). Leave off for notices present when the page loads. */
  readonly announce?: boolean;
  readonly className?: string;
}

const tones = {
  error: { icon: ErrorIcon, colour: "text-danger", frame: "border-danger bg-danger-subtle" },
  success: { icon: SuccessIcon, colour: "text-success", frame: "border-success bg-success-subtle" },
  info: { icon: InfoIcon, colour: "text-info", frame: "border-info bg-info-subtle" },
} as const;

/** A message about the whole form, with an icon so colour is never the only signal. */
export function FormAlert({ tone, children, announce = false, className }: FormAlertProps) {
  const { icon: Icon, colour, frame } = tones[tone];
  return (
    <div
      role={announce ? (tone === "error" ? "alert" : "status") : undefined}
      className={cx(
        "flex items-start gap-2 rounded-control border p-3 text-body text-fg",
        frame,
        className,
      )}
    >
      <Icon size="sm" className={cx("mt-0.5 shrink-0", colour)} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
