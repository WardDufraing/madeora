import { getTranslations } from "next-intl/server";

import { ErrorState } from "@/components/ui/states";
import type { WidgetConfigs } from "@/dashboard/widgets";
import { readGoal, readGoals } from "@/goals/data";

import { GoalProgressWidgetBody, GoalsWidgetBody } from "./goal-widget-body";

type WidgetHome = { readonly id: string; readonly name: string } | null;

/**
 * The Goals widget (S30): the active goals of one context (Personal space, the Home, or a source
 * Home), read with the viewer's session. Achieved and archived goals leave it; a Home the viewer
 * has left shows nothing.
 */
export async function GoalsWidget({
  home,
  config,
}: {
  readonly home: WidgetHome;
  readonly config: WidgetConfigs["goals"];
}) {
  const [t, list] = await Promise.all([
    getTranslations("Goals"),
    readGoals(home?.id ?? null, "active"),
  ]);
  if (list.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  return <GoalsWidgetBody home={home} initialList={list.value} count={config.count} />;
}

/**
 * The Goal progress widget (S30): one chosen goal. A goal that is not chosen, gone, archived, from
 * another context or no longer visible says so explicitly; an achieved one stays with "Achieved".
 */
export async function GoalProgressWidget({
  home,
  config,
}: {
  readonly home: WidgetHome;
  readonly config: WidgetConfigs["goal-progress"];
}) {
  const t = await getTranslations("Goals");
  if (!config.goalId) {
    return <p className="text-body text-fg-muted">{t("widgetChooseGoal")}</p>;
  }
  const goal = await readGoal(config.goalId);
  if (goal.status === "not-found") {
    return <p className="text-body text-fg-muted">{t("widgetGoalUnavailable")}</p>;
  }
  if (goal.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  // Only a goal of the widget's own context, and not an archived one (archived goals leave widgets).
  if (goal.value.homeId !== (home?.id ?? null) || goal.value.status === "archived") {
    return <p className="text-body text-fg-muted">{t("widgetGoalUnavailable")}</p>;
  }
  return <GoalProgressWidgetBody home={home} initialGoal={goal.value} />;
}
