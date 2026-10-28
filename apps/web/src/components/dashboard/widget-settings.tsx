"use client";

import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import type { DashboardWidget } from "@/dashboard/layout";
import {
  choreScheduleLayouts,
  choreScheduleLimits,
  leaderboardWidgetCounts,
  leaderboardWidgetPeriods,
  mealWidgetModes,
  notificationCounts,
  recipeWidgetCounts,
  recipeWidgetModes,
  parseConfig,
  defaultConfig,
  weeklyPointsViews,
  widgetRegistry,
} from "@/dashboard/widgets";

import { ShoppingWidgetSettings } from "@/components/shopping/shopping-widget-settings";

import { ChoreWidgetSettings } from "./chore-widget-settings";
import { TaskWidgetSettings } from "./task-widget-settings";

/**
 * A widget's own settings in edit mode (S17). Each type's settings come from its registry schema;
 * the server checks them again on save. Changes show in the widget once the dashboard is saved.
 */
export function WidgetSettings({
  widget,
  contextHomeId,
  onChange,
}: {
  readonly widget: DashboardWidget;
  /** The Home the widget's data comes from, or null for the Personal space. */
  readonly contextHomeId: string | null;
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
    case "home-vacation":
    case "my-points":
      return <p className="text-helper text-fg-muted">{t("settingsNone")}</p>;
    case "weekly-points":
      return (
        <SelectField
          label={t("settingPointsView")}
          value={String(config.view)}
          options={weeklyPointsViews.map((view) => ({
            value: view,
            label: t(`settingPointsView_${view}`),
          }))}
          onChange={(event) => {
            set("view", event.currentTarget.value);
          }}
        />
      );
    case "points-leaderboard":
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label={t("settingLeaderboardPeriod")}
            value={String(config.period)}
            options={leaderboardWidgetPeriods.map((period) => ({
              value: period,
              label: t(`settingLeaderboardPeriod_${period}`),
            }))}
            onChange={(event) => {
              set("period", event.currentTarget.value);
            }}
          />
          <SelectField
            label={t("settingCount")}
            value={String(config.count)}
            options={leaderboardWidgetCounts.map((count) => ({
              value: String(count),
              label: t("settingCountOption", { count }),
            }))}
            onChange={(event) => {
              set("count", Number(event.currentTarget.value));
            }}
          />
        </div>
      );
    case "tasks": {
      const parsed = widgetRegistry.tasks.config.safeParse(widget.config);
      const tasks = parsed.success ? parsed.data : widgetRegistry.tasks.config.parse({});
      return <TaskWidgetSettings config={tasks} homeId={contextHomeId} onChange={onChange} />;
    }
    case "my-chores": {
      const parsed = widgetRegistry["my-chores"].config.safeParse(widget.config);
      return (
        <ChoreWidgetSettings
          type="my-chores"
          config={parsed.success ? parsed.data : widgetRegistry["my-chores"].config.parse({})}
          homeId={contextHomeId}
          onChange={onChange}
        />
      );
    }
    case "home-chores": {
      const parsed = widgetRegistry["home-chores"].config.safeParse(widget.config);
      return (
        <ChoreWidgetSettings
          type="home-chores"
          config={parsed.success ? parsed.data : widgetRegistry["home-chores"].config.parse({})}
          homeId={contextHomeId}
          onChange={onChange}
        />
      );
    }
    case "chore-schedule":
      return (
        <div className="flex flex-col gap-4">
          <SelectField
            label={t("settingScheduleLayout")}
            value={String(config.layout)}
            options={choreScheduleLayouts.map((layout) => ({
              value: layout,
              label: layout === "matrix" ? t("scheduleLayoutMatrix") : t("scheduleLayoutCards"),
            }))}
            onChange={(event) => {
              set("layout", event.currentTarget.value);
            }}
          />
          <SelectField
            label={t("settingScheduleLimit")}
            value={String(config.limit)}
            options={choreScheduleLimits.map((limit) => ({
              value: String(limit),
              label: t("settingScheduleLimitOption", { count: limit }),
            }))}
            onChange={(event) => {
              set("limit", Number(event.currentTarget.value));
            }}
          />
        </div>
      );
    case "recipes": {
      const random = config.mode === "random";
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label={t("settingRecipeMode")}
            value={String(config.mode)}
            options={recipeWidgetModes.map((mode) => ({
              value: mode,
              label: t(`settingRecipeMode_${mode}`),
            }))}
            onChange={(event) => {
              const mode = event.currentTarget.value;
              // Random shows one recipe at a time (with Show another).
              onChange({ ...config, mode, ...(mode === "random" ? { count: 1 } : {}) });
            }}
          />
          <SelectField
            label={t("settingRecipeCount")}
            value={String(random ? 1 : config.count)}
            disabled={random}
            {...(random ? { description: t("settingRecipeCountRandom") } : {})}
            options={recipeWidgetCounts.map((count) => ({
              value: String(count),
              label: t("settingRecipeCountOption", { count }),
            }))}
            onChange={(event) => {
              set("count", Number(event.currentTarget.value));
            }}
          />
        </div>
      );
    }
    case "shopping": {
      const parsed = widgetRegistry.shopping.config.safeParse(widget.config);
      return (
        <ShoppingWidgetSettings
          config={parsed.success ? parsed.data : widgetRegistry.shopping.config.parse({})}
          homeId={contextHomeId}
          onChange={onChange}
        />
      );
    }
    case "meal-planner": {
      const mode = mealWidgetModes.find((value) => value === config.mode) ?? "today";
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label={t("settingMealMode")}
            value={mode}
            options={mealWidgetModes.map((value) => ({
              value,
              label: {
                today: t("settingMealMode_today"),
                day: t("settingMealMode_day"),
                week: t("settingMealMode_week"),
              }[value],
            }))}
            onChange={(event) => {
              const next = event.currentTarget.value;
              onChange({
                mode: next,
                date:
                  next === "day" ? (typeof config.date === "string" ? config.date : null) : null,
              });
            }}
          />
          {mode === "day" ? (
            <TextField
              label={t("settingMealDate")}
              type="date"
              value={typeof config.date === "string" ? config.date : ""}
              onChange={(event) => {
                set("date", event.currentTarget.value === "" ? null : event.currentTarget.value);
              }}
            />
          ) : null}
        </div>
      );
    }
    case "chore-approvals": {
      const parsed = widgetRegistry["chore-approvals"].config.safeParse(widget.config);
      return (
        <ChoreWidgetSettings
          type="chore-approvals"
          config={parsed.success ? parsed.data : widgetRegistry["chore-approvals"].config.parse({})}
          homeId={contextHomeId}
          onChange={onChange}
        />
      );
    }
  }
}
