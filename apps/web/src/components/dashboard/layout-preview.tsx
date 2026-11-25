"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { stackOrder } from "@/dashboard/geometry";
import type { LayoutPreview } from "@/dashboard/preview";
import { breakpointColumns, type Breakpoint } from "@/dashboard/widgets";

import { useWidgetLabels } from "./use-widget-labels";

type Screen = "desktop" | "mobile";

const screenBreakpoint = { desktop: "lg", mobile: "sm" } as const satisfies Record<
  Screen,
  Breakpoint
>;

/** Pixel height of one grid row in the preview (the dashboard's is 88). */
const PREVIEW_ROW = 14;

/**
 * A schematic of a dashboard arrangement (UX2c; redesign decisions 31 and 32: preview before
 * restoring a template or a version). Widgets are drawn as labelled boxes in their places, for the
 * desktop or the phone arrangement, never with their content, so a preview reads no records. Hidden
 * widgets are drawn dashed and named as hidden. Screen readers get the same arrangement as a list in
 * reading order.
 */
export function LayoutPreviewView({
  preview,
  label,
}: {
  readonly preview: LayoutPreview;
  /** What is previewed, for the list's accessible name. */
  readonly label: string;
}) {
  const t = useTranslations("DashboardHistory");
  const labels = useWidgetLabels();
  const listId = useId();
  const [screen, setScreen] = useState<Screen>("desktop");
  const breakpoint = screenBreakpoint[screen];
  const cols = breakpointColumns[breakpoint];
  const widgets = new Map(preview.widgets.map((widget) => [widget.id, widget]));
  const placements = preview.placements[breakpoint].filter((p) => widgets.has(p.id));
  const order = stackOrder(placements);
  const byId = new Map(placements.map((p) => [p.id, p]));
  const rows = placements.reduce((max, p) => Math.max(max, p.y + p.h), 0);

  return (
    <div className="flex flex-col gap-3" data-testid="layout-preview">
      <div role="group" aria-label={t("previewScreen")} className="flex flex-wrap gap-2">
        {(["desktop", "mobile"] as const).map((option) => (
          <Button
            key={option}
            size="sm"
            variant={screen === option ? "primary" : "secondary"}
            aria-pressed={screen === option}
            onClick={() => {
              setScreen(option);
            }}
          >
            {option === "desktop" ? t("previewDesktop") : t("previewMobile")}
          </Button>
        ))}
      </div>

      {placements.length === 0 ? (
        <p className="text-body text-fg-muted">{t("previewEmpty")}</p>
      ) : (
        <>
          <div
            aria-hidden="true"
            className={cx(
              "grid gap-1 overflow-hidden rounded-card border border-line bg-surface-sunken p-2",
              screen === "mobile" && "mx-auto w-full max-w-48",
            )}
            style={{
              gridTemplateColumns: `repeat(${String(cols)}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${String(rows)}, ${String(PREVIEW_ROW)}px)`,
            }}
          >
            {placements.map((p) => {
              const widget = widgets.get(p.id);
              if (!widget) return null;
              return (
                <div
                  key={p.id}
                  className={cx(
                    "flex min-w-0 items-start overflow-hidden rounded-sm border px-1.5 py-1",
                    "text-helper leading-tight",
                    widget.hidden
                      ? "border-dashed border-line text-fg-muted"
                      : "border-line bg-accent-subtle text-fg",
                  )}
                  style={{
                    gridColumn: `${String(p.x + 1)} / span ${String(p.w)}`,
                    gridRow: `${String(p.y + 1)} / span ${String(p.h)}`,
                  }}
                >
                  <span className="truncate">{labels.name(widget.type)}</span>
                </div>
              );
            })}
          </div>
          <ul id={listId} aria-label={label} className="sr-only">
            {order.map((id) => {
              const widget = widgets.get(id);
              const place = byId.get(id);
              if (!widget || !place) return null;
              return (
                <li key={id}>
                  {t("previewItem", {
                    name: labels.name(widget.type),
                    width: place.w,
                    height: place.h,
                  })}
                  {widget.hidden ? ` ${t("previewHidden")}` : ""}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
