"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import { SelectField } from "@/components/ui/select-field";
import type { WidgetConfigs } from "@/dashboard/widgets";
import { GOALS_ENDPOINT, sendGoalRequest, type GoalList } from "@/goals/api";
import { goalKeys } from "@/goals/format";

type Config = WidgetConfigs["goal-progress"];

/**
 * The Goal progress widget's setting (S30): which goal of the widget's context it shows, from the
 * viewer's active and completed goals there. A chosen goal that is gone stays shown as unavailable
 * until another is chosen. The server checks the goal again on every render.
 */
export function GoalProgressWidgetSettings({
  config,
  homeId,
  onChange,
}: {
  readonly config: Config;
  readonly homeId: string | null;
  readonly onChange: (config: Config) => void;
}) {
  const t = useTranslations("Goals");
  const read = (view: "active" | "completed") => () => {
    const search = new URLSearchParams({ view });
    if (homeId) search.set("homeId", homeId);
    return sendGoalRequest<{ list: GoalList }>("GET", `${GOALS_ENDPOINT}?${search.toString()}`);
  };
  const active = useQuery({
    queryKey: [...goalKeys.list(homeId, "active"), "options"],
    queryFn: read("active"),
    retry: false,
  });
  const completed = useQuery({
    queryKey: [...goalKeys.list(homeId, "completed"), "options"],
    queryFn: read("completed"),
    retry: false,
  });
  if (active.isPending || completed.isPending) {
    return <p className="text-helper text-fg-muted">{t("loading")}</p>;
  }
  if (active.error || completed.error) {
    return (
      <FormAlert tone="error" announce>
        {t("widgetSettingsFailed")}
      </FormAlert>
    );
  }
  const goals = [...active.data.list.goals, ...completed.data.list.goals];
  const known = config.goalId === null || goals.some((goal) => goal.id === config.goalId);
  return (
    <SelectField
      label={t("widgetGoalSetting")}
      value={config.goalId ?? ""}
      options={[
        { value: "", label: t("widgetGoalNone") },
        ...(known ? [] : [{ value: config.goalId ?? "", label: t("widgetGoalUnavailable") }]),
        ...goals.map((goal) => ({
          value: goal.id,
          label:
            goal.status === "achieved" ? t("goalAchievedOption", { goal: goal.title }) : goal.title,
        })),
      ]}
      onChange={(event) => {
        const value = event.currentTarget.value;
        onChange({ goalId: value === "" ? null : value });
      }}
      data-testid="goal-progress-widget-goal"
    />
  );
}
