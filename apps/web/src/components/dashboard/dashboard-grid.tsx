import type { ReactNode } from "react";

import { cx } from "@/components/ui/cx";
import { visiblePlacements, type DashboardLayout } from "@/dashboard/layout";
import { breakpoints } from "@/dashboard/widgets";
import type { WidgetEntry } from "@/dashboard/view-types";

/**
 * A dashboard in normal use (S17): a plain CSS grid, laid out by container queries on the
 * dashboard's own width with the same breakpoints, columns and row height as edit mode. Nothing
 * here can be dragged or resized, so normal use never changes the layout (spec: "normal dashboard
 * use must not accidentally trigger layout edits"), and the server renders the final positions, so
 * nothing shifts when the page becomes interactive. Hidden widgets are left out and the rest close
 * up. Widgets follow the reading order of the phone layout (top to bottom) for keyboard and screen
 * reader users, whatever the screen size.
 */
export function DashboardGrid({
  layout,
  widgets,
  emptyState,
}: {
  readonly layout: DashboardLayout;
  readonly widgets: readonly WidgetEntry[];
  /** Shown when no widget is visible. */
  readonly emptyState: ReactNode;
}) {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const positions = Object.fromEntries(
    breakpoints.map((breakpoint) => [
      breakpoint,
      new Map(visiblePlacements(layout, breakpoint).map((p) => [p.id, p])),
    ]),
  );
  const order = visiblePlacements(layout, "sm")
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((p) => p.id);
  if (order.length === 0) return <>{emptyState}</>;

  return (
    <div className="@container" data-testid="dashboard-grid">
      <ol
        className={cx(
          "grid auto-rows-[88px] gap-4",
          "[grid-template-columns:repeat(1,minmax(0,1fr))]",
          "@min-[640px]:[grid-template-columns:repeat(6,minmax(0,1fr))]",
          "@min-[1024px]:[grid-template-columns:repeat(12,minmax(0,1fr))]",
        )}
      >
        {order.map((id) => {
          const widget = byId.get(id);
          if (!widget) return null;
          const style: Record<string, string> = {};
          for (const breakpoint of breakpoints) {
            const p = positions[breakpoint]?.get(id);
            if (!p) continue;
            style[`--dash-${breakpoint}-col`] = `${String(p.x + 1)} / span ${String(p.w)}`;
            style[`--dash-${breakpoint}-row`] = `${String(p.y + 1)} / span ${String(p.h)}`;
          }
          return (
            <li
              key={id}
              style={style}
              className={cx(
                "min-h-0",
                "[grid-column:var(--dash-sm-col)] [grid-row:var(--dash-sm-row)]",
                "@min-[640px]:[grid-column:var(--dash-md-col)] @min-[640px]:[grid-row:var(--dash-md-row)]",
                "@min-[1024px]:[grid-column:var(--dash-lg-col)] @min-[1024px]:[grid-row:var(--dash-lg-row)]",
              )}
              data-testid="dashboard-widget"
              data-widget-id={id}
            >
              <WidgetFrame widget={widget}>{widget.body}</WidgetFrame>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** A widget's surface and title. A Home widget's source Home is part of its title everywhere. */
export function WidgetFrame({
  widget,
  children,
  actions,
  className,
}: {
  readonly widget: Pick<WidgetEntry, "title" | "unavailable">;
  readonly children: ReactNode;
  /** Edit-mode controls next to the title. */
  readonly actions?: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    // An article, not a region: a widget named like a part of the app (Notifications) must not add
    // a second landmark of that name.
    <article
      aria-label={widget.title}
      className={cx(
        "flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface text-fg shadow-card",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        {/* Wraps instead of truncating, so a Home widget's source Home stays readable on a phone. */}
        <h2 className="min-w-0 flex-1 text-body font-semibold break-words">{widget.title}</h2>
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
    </article>
  );
}
