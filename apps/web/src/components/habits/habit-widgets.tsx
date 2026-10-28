import { getTranslations } from "next-intl/server";

import { ErrorState } from "@/components/ui/states";
import type { WidgetConfigs } from "@/dashboard/widgets";
import { readHabitInsights, readHabits } from "@/habits/data";
import { listTaskMembers } from "@/tasks/data";

import { HabitInsightsWidgetBody, HabitsWidgetBody } from "./habit-widget-body";

type WidgetHome = { readonly id: string; readonly name: string } | null;

/**
 * The Habits widget (S28): today's active habits of one context (Personal space, the Home, or a
 * source Home), read with the viewer's session. Ended and archived habits are left out; a Home the
 * viewer has left shows nothing.
 */
export async function HabitsWidget({
  home,
  config,
}: {
  readonly home: WidgetHome;
  readonly config: WidgetConfigs["habits"];
}) {
  const homeId = home?.id ?? null;
  const [t, list, members] = await Promise.all([
    getTranslations("Habits"),
    readHabits(homeId, "active"),
    homeId ? listTaskMembers(homeId) : Promise.resolve(null),
  ]);
  if (list.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  return (
    <HabitsWidgetBody
      homeId={homeId}
      initialList={list.value}
      count={config.count}
      members={members?.status === "ok" ? members.value : []}
    />
  );
}

/**
 * The Habit insights widget (S28): one chosen habit's completion rate over the last 30 days, its
 * current streak and a 12-week trend. A habit that is not chosen, gone, from another context or no
 * longer visible says so explicitly.
 */
export async function HabitInsightsWidget({
  home,
  config,
}: {
  readonly home: WidgetHome;
  readonly config: WidgetConfigs["habit-insights"];
}) {
  const t = await getTranslations("Habits");
  if (!config.habitId) {
    return <p className="text-body text-fg-muted">{t("widgetChooseHabit")}</p>;
  }
  const insights = await readHabitInsights(config.habitId, 30);
  if (insights.status === "not-found") {
    return <p className="text-body text-fg-muted">{t("widgetHabitUnavailable")}</p>;
  }
  if (insights.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  // Only a habit of the widget's own context.
  if (insights.value.habit.homeId !== (home?.id ?? null)) {
    return <p className="text-body text-fg-muted">{t("widgetHabitUnavailable")}</p>;
  }
  return <HabitInsightsWidgetBody insights={insights.value} />;
}
