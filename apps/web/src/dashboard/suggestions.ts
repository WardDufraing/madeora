import { addWidget, canAddWidget, type DashboardLayout, type DashboardWidget } from "./layout";

/**
 * Adds the chosen shared-default widgets to a person's own view (UX2d; redesign decision 34). Each
 * keeps the id it has in the shared default, so the database knows it was handled and stops
 * suggesting it. Like any widget added in edit mode each lands at the bottom of every screen size,
 * so nothing already on the person's dashboard moves. A widget already on the view is skipped, and
 * so is one that no longer fits below the last row; the rest are still added.
 */
export function withSuggestions(
  layout: DashboardLayout,
  widgets: readonly DashboardWidget[],
): {
  readonly layout: DashboardLayout;
  readonly added: readonly string[];
  readonly skipped: number;
} {
  let next = layout;
  const added: string[] = [];
  let skipped = 0;
  for (const widget of widgets) {
    if (
      next.widgets.some((existing) => existing.id === widget.id) ||
      !canAddWidget(next, widget.type)
    ) {
      skipped += 1;
      continue;
    }
    next = addWidget(next, widget);
    added.push(widget.id);
  }
  return { layout: next, added, skipped };
}
