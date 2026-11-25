"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { sizePresets, stackOrder, type Placement, type SizePresetId } from "@/dashboard/geometry";
import type { DashboardWidget } from "@/dashboard/layout";

export const presetKey = {
  small: "presetSmall",
  medium: "presetMedium",
  large: "presetLarge",
  wide: "presetWide",
} as const satisfies Record<SizePresetId, string>;

/**
 * The list view of mobile edit mode (UX2b; redesign decision 30): the phone layout as an ordered
 * list with Move up / Move down, a size choice, Hide and Remove on every row. It edits the same
 * draft as the visual grid, and only the phone arrangement: desktop and tablet stay as they are
 * (decision 25). Nothing is dragged, so it works with a keyboard, a screen reader or one thumb.
 */
export function StackEditor({
  widgets,
  placements,
  titleOf,
  onMove,
  onSize,
  onToggleHidden,
  onRemove,
}: {
  readonly widgets: readonly DashboardWidget[];
  /** The phone (`sm`) placements. */
  readonly placements: readonly Placement[];
  readonly titleOf: (widget: DashboardWidget) => string;
  readonly onMove: (widget: DashboardWidget, direction: "up" | "down") => void;
  readonly onSize: (widget: DashboardWidget, preset: SizePresetId) => void;
  readonly onToggleHidden: (widget: DashboardWidget) => void;
  readonly onRemove: (widget: DashboardWidget) => void;
}) {
  const t = useTranslations("Dashboard");
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const position = new Map(placements.map((p) => [p.id, p]));
  const order = stackOrder(placements).flatMap((id) => {
    const widget = byId.get(id);
    return widget ? [widget] : [];
  });

  if (order.length === 0) return <p className="text-body text-fg-muted">{t("editEmpty")}</p>;

  return (
    <ol className="flex flex-col gap-2" data-testid="dashboard-stack-editor">
      {order.map((widget, index) => {
        const title = titleOf(widget);
        const presets = sizePresets(widget.type, "sm");
        const current = position.get(widget.id);
        const chosen = presets.find((preset) => preset.h === current?.h)?.id ?? "";
        return (
          <li
            key={widget.id}
            className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3 text-fg"
            data-testid="dashboard-stack-row"
            data-widget-id={widget.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-body font-medium break-words">
                <span className="sr-only">
                  {t("stackPosition", { position: index + 1, total: order.length })}{" "}
                </span>
                {title}
              </p>
              {widget.hidden ? (
                <span className="rounded-control border border-line px-2 text-helper text-fg-muted">
                  {t("hiddenBadge")}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={index === 0}
                onClick={() => {
                  onMove(widget, "up");
                }}
                aria-label={t("moveNamed", { action: t("moveUp"), widget: title })}
              >
                {t("moveUp")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={index === order.length - 1}
                onClick={() => {
                  onMove(widget, "down");
                }}
                aria-label={t("moveNamed", { action: t("moveDown"), widget: title })}
              >
                {t("moveDown")}
              </Button>
              {presets.length > 1 ? (
                <SelectField
                  label={t("sizeOf", { widget: title })}
                  value={chosen}
                  options={[
                    ...(chosen === "" ? [{ value: "", label: t("presetCustom") }] : []),
                    ...presets.map((preset) => ({
                      value: preset.id,
                      label: t(presetKey[preset.id]),
                    })),
                  ]}
                  onChange={(event) => {
                    const value = presets.find((preset) => preset.id === event.currentTarget.value);
                    if (value) onSize(widget, value.id);
                  }}
                />
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onToggleHidden(widget);
                }}
                aria-label={t("moveNamed", {
                  action: widget.hidden ? t("showWidget") : t("hideWidget"),
                  widget: title,
                })}
              >
                {widget.hidden ? t("showWidget") : t("hideWidget")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  onRemove(widget);
                }}
                aria-label={t("moveNamed", { action: t("removeWidget"), widget: title })}
              >
                {t("removeWidget")}
              </Button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
