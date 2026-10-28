import { getTranslations } from "next-intl/server";

import { zonedParts } from "@/chores/format";
import { ErrorState } from "@/components/ui/states";
import type { WidgetConfigs } from "@/dashboard/widgets";
import { getDateTimeFormats } from "@/invitations/server";
import { readMealPlan } from "@/meals/data";
import { weekOf } from "@/meals/format";
import { getRegionalFormats } from "@/preferences/server";

import { MealWidgetBody } from "./meal-widget-body";

/**
 * A Meal planner widget (S27): today's meals, a chosen day's, or a compact week of one context
 * (Personal space, the Home, or a source Home), read with the viewer's session. Nothing is shown
 * from a Home the viewer has left, and a recipe they may not see from the context stays
 * "Recipe unavailable".
 */
export async function MealWidget({
  home,
  config,
}: {
  readonly home: { readonly id: string; readonly name: string; readonly timeZone: string } | null;
  readonly config: WidgetConfigs["meal-planner"];
}) {
  const [t, formats, regional] = await Promise.all([
    getTranslations("Meals"),
    getDateTimeFormats(),
    getRegionalFormats(),
  ]);
  const today = zonedParts(new Date().toISOString(), home?.timeZone ?? formats.timeZone).date;
  const date = config.mode === "day" && config.date ? config.date : today;
  const week = weekOf(date, regional.effective.weekStart);
  const from = config.mode === "week" ? (week[0] ?? date) : date;
  const to = config.mode === "week" ? (week[6] ?? date) : date;
  const plan = await readMealPlan(home?.id ?? null, from, to);
  if (plan.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  return <MealWidgetBody homeId={home?.id ?? null} initialPlan={plan.value} mode={config.mode} />;
}
