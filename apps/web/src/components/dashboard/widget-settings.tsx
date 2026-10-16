"use client";

import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import type { DashboardWidget } from "@/dashboard/layout";
import { notificationCounts, parseConfig, defaultConfig } from "@/dashboard/widgets";

/**
 * A widget's own settings in edit mode (S17). Each type's settings come from its registry schema;
 * the server checks them again on save. Changes show in the widget once the dashboard is saved.
 */
export function WidgetSettings({
  widget,
  onChange,
}: {
  readonly widget: DashboardWidget;
  readonly onChange: (config: Record<string, unknown>) => void;
}) {
  const t = useTranslations("Dashboard");
  const config = parseConfig(widget.type, widget.config) ?? defaultConfig(widget.type);
  const set = (key: string, value: unknown) => {
    onChange({ ...config, [key]: value });
  };

  switch (widget.type) {
    case "welcome":
      return (
        <Checkbox
          label={t("settingShowDate")}
          checked={config.showDate === true}
          onChange={(event) => {
            set("showDate", event.currentTarget.checked);
          }}
        />
      );
    case "notifications":
      return (
        <SelectField
          label={t("settingCount")}
          value={String(config.count)}
          options={notificationCounts.map((count) => ({
            value: String(count),
            label: t("settingCountOption", { count }),
          }))}
          onChange={(event) => {
            set("count", Number(event.currentTarget.value));
          }}
        />
      );
    case "home-members":
      return (
        <Checkbox
          label={t("settingShowRoles")}
          checked={config.showRoles === true}
          onChange={(event) => {
            set("showRoles", event.currentTarget.checked);
          }}
        />
      );
    case "quick-actions":
      return <p className="text-helper text-fg-muted">{t("settingsNone")}</p>;
  }
}
