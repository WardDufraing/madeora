"use client";

import { useTranslations } from "next-intl";
import { GridLayout, useContainerWidth, type Layout } from "react-grid-layout";

import { cx } from "@/components/ui/cx";
import { orderFromPlacements, placeDisplayWidgets, type DisplayWidget } from "@/displays/layout";

const PREVIEW_GAP = 8;

/**
 * The display editor's preview (S44): the widgets where the display will put them, in landscape
 * or portrait, and drag-and-drop to reorder them. Positions always come from the display's own
 * placement rule; a drop only changes the order (read top to bottom, left to right), so what the
 * preview shows after a drop is exactly what the display shows. Sizes are chosen per widget in the
 * list, which is also the keyboard way to reorder (Move up / Move down), so the preview itself is
 * pointer-only and hidden from assistive technology.
 */
export function DisplayLayoutPreview({
  widgets,
  columns,
  portrait,
  onReorder,
}: {
  readonly widgets: readonly DisplayWidget[];
  readonly columns: number;
  readonly portrait: boolean;
  readonly onReorder: (widgets: DisplayWidget[]) => void;
}) {
  const t = useTranslations("DisplayConfig");
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const layout: Layout = placeDisplayWidgets(widgets, columns).map((place) => ({
    i: place.id,
    x: place.x,
    y: place.y,
    w: place.w,
    h: place.h,
    isResizable: false,
  }));
  const rowHeight = Math.max(24, Math.round((width - PREVIEW_GAP * (columns + 1)) / columns / 2));

  return (
    <div
      className={cx(
        "rounded-card border border-line bg-surface-sunken",
        portrait ? "w-56" : "w-full max-w-sm",
      )}
      data-testid="display-config-preview"
      aria-hidden="true"
    >
      <div ref={containerRef}>
        {mounted ? (
          <GridLayout
            width={width}
            layout={layout}
            gridConfig={{
              cols: columns,
              rowHeight,
              margin: [PREVIEW_GAP, PREVIEW_GAP],
              containerPadding: [PREVIEW_GAP, PREVIEW_GAP],
            }}
            dragConfig={{ enabled: widgets.length > 1 }}
            resizeConfig={{ enabled: false }}
            onDragStop={(next) => {
              const ordered = orderFromPlacements(widgets, next);
              if (ordered.some((widget, index) => widget.id !== widgets[index]?.id)) {
                onReorder(ordered);
              }
            }}
          >
            {widgets.map((widget) => (
              <div
                key={widget.id}
                data-testid="display-preview-widget"
                data-widget-type={widget.type}
                className="flex cursor-grab items-center justify-center overflow-hidden rounded-control border border-line bg-surface p-1 text-helper text-fg-muted active:cursor-grabbing"
              >
                {t(`widget.${widget.type}`)}
              </div>
            ))}
          </GridLayout>
        ) : null}
      </div>
    </div>
  );
}
