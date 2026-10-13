import { ErrorIcon, SpinnerIcon } from "@madeora/icons";
import type { ReactNode } from "react";

import { cx } from "./cx";

interface StateProps {
  readonly title: string;
  readonly description?: ReactNode;
  /** A next step, such as a button to add the first item or to try again. */
  readonly action?: ReactNode;
  readonly className?: string;
}

const frame = "flex flex-col items-center gap-2 px-4 py-8 text-center";

/** Nothing here yet. Invites the next step without inventing data (spec: no fake content). */
export function EmptyState({ title, description, action, className }: StateProps) {
  return (
    <div className={cx(frame, className)}>
      <p className="text-body font-semibold text-fg">{title}</p>
      {description ? <div className="max-w-sm text-helper text-fg-muted">{description}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export interface LoadingStateProps {
  /** Visible and announced text, for example "Loading tasks…" (translated by the caller). */
  readonly label: string;
  readonly className?: string;
}

/** Content is on its way. The label is always visible, so the spinner is never the only signal. */
export function LoadingState({ label, className }: LoadingStateProps) {
  return (
    <div role="status" className={cx(frame, "text-fg-muted", className)}>
      <SpinnerIcon className="animate-spin text-accent-fg motion-reduce:animate-none" />
      <p className="text-helper">{label}</p>
    </div>
  );
}

export interface ErrorStateProps extends StateProps {
  /**
   * Announce immediately to screen readers. Use when the error replaces content the person was
   * waiting for after an action; leave it off for errors already present when the page loads.
   */
  readonly announce?: boolean;
}

/** Something failed. Says what happened and offers a way forward, such as Try again. */
export function ErrorState({
  title,
  description,
  action,
  announce = false,
  className,
}: ErrorStateProps) {
  return (
    <div role={announce ? "alert" : undefined} className={cx(frame, className)}>
      <ErrorIcon size="lg" className="text-danger" />
      <p className="text-body font-semibold text-fg">{title}</p>
      {description ? <div className="max-w-sm text-helper text-fg-muted">{description}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
