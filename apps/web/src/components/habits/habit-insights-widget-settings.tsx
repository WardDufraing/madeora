"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import { SelectField } from "@/components/ui/select-field";
import type { WidgetConfigs } from "@/dashboard/widgets";
import { HABITS_ENDPOINT, sendHabitRequest, type HabitList } from "@/habits/api";
import { habitKeys } from "@/habits/format";

type Config = WidgetConfigs["habit-insights"] & WidgetConfigs["habit-progress"];

/**
 * The Habit insights widget's setting (S28): which habit of the widget's context it shows, from the
 * viewer's active and ended habits there. A chosen habit that is gone stays shown as unavailable
 * until another is chosen. The server checks the habit again on every render.
 */
export function HabitInsightsWidgetSettings({
  config,
  homeId,
  onChange,
  numericOnly = false,
}: {
  readonly config: Config;
  readonly homeId: string | null;
  readonly onChange: (config: Config) => void;
  /** The Habit progress widget offers habits with a numeric target only. */
  readonly numericOnly?: boolean;
}) {
  const t = useTranslations("Habits");
  const read = (view: "active" | "ended") => () => {
    const search = new URLSearchParams({ view });
    if (homeId) search.set("homeId", homeId);
    return sendHabitRequest<{ list: HabitList }>("GET", `${HABITS_ENDPOINT}?${search.toString()}`);
  };
  const active = useQuery({
    queryKey: [...habitKeys.all, "options", homeId ?? "personal", "active"],
    queryFn: read("active"),
    retry: false,
  });
  const ended = useQuery({
    queryKey: [...habitKeys.all, "options", homeId ?? "personal", "ended"],
    queryFn: read("ended"),
    retry: false,
  });
  if (active.isPending || ended.isPending) {
    return <p className="text-helper text-fg-muted">{t("loading")}</p>;
  }
  if (active.error || ended.error) {
    return (
      <FormAlert tone="error" announce>
        {t("widgetSettingsFailed")}
      </FormAlert>
    );
  }
  const habits = [...active.data.list.habits, ...ended.data.list.habits].filter(
    (habit) =>
      !numericOnly || habit.tracking.mode === "numeric" || habit.nextTracking?.mode === "numeric",
  );
  const known = config.habitId === null || habits.some((habit) => habit.id === config.habitId);
  return (
    <SelectField
      label={t("widgetHabitSetting")}
      value={config.habitId ?? ""}
      options={[
        { value: "", label: t("widgetHabitNone") },
        ...(known ? [] : [{ value: config.habitId ?? "", label: t("widgetHabitUnavailable") }]),
        ...habits.map((habit) => ({
          value: habit.id,
          label:
            habit.status === "ended" ? t("habitEndedOption", { name: habit.name }) : habit.name,
        })),
      ]}
      onChange={(event) => {
        const value = event.currentTarget.value;
        onChange({ habitId: value === "" ? null : value });
      }}
      data-testid={numericOnly ? "habit-progress-widget-habit" : "habit-insights-widget-habit"}
    />
  );
}
