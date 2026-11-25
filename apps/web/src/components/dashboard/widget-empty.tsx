import type { ReactNode } from "react";

import { EmptyState } from "@/components/ui/states";
import type { EmptyStateMode } from "@/dashboard/widgets";

/**
 * A widget's "nothing here" state in the person's chosen presentation (UX2a; redesign decision 9).
 * `full` is the friendly message, `compact` one quiet line, and `hide` renders the compact line
 * with a marker the dashboard grid uses to hide the whole widget while it is empty (render-only:
 * the saved layout is untouched, and nothing is hidden when this is not an empty result). Only a
 * genuinely empty result belongs here; an error, a restricted state or a filtered-out list keeps
 * its own state so it is never mistaken for "empty".
 */
export function WidgetEmpty({
  mode,
  title,
  description,
  action,
}: {
  readonly mode: EmptyStateMode;
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
}) {
  if (mode === "full") {
    return <EmptyState title={title} description={description} action={action} />;
  }
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
      data-widget-empty={mode}
      data-testid="widget-empty"
    >
      <p className="text-helper text-fg-muted">{title}</p>
      {action}
    </div>
  );
}

/**
 * Marks content only worth showing when the widget is wide enough (UX2a; adaptive hierarchy): the
 * widget's own width, not the screen's, so the same snapped size behaves the same everywhere.
 * `m` appears from about 19rem, `l` from about 29rem.
 */
export function WidgetDetail({
  minSize,
  className,
  children,
}: {
  readonly minSize: "m" | "l";
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const hide = minSize === "m" ? "@max-[19rem]/widget:hidden" : "@max-[29rem]/widget:hidden";
  return <div className={className ? `${hide} ${className}` : hide}>{children}</div>;
}
