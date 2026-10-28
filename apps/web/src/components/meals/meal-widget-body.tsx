"use client";

import { RepeatIcon, WarningIcon } from "@madeora/icons";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { addDays, cellKey, daysBetween, groupByCell } from "@madeora/domain/meals";

import { cx } from "@/components/ui/cx";
import type { MealPlan, PlannedMeal } from "@/meals/api";
import { formatMealDate, mealKey, mealsPath, shownSlots } from "@/meals/format";

import { MealDialog, type MealDialogTarget } from "./meal-dialog";
import { useMealPlan } from "./meal-planner";
import { useMealTexts } from "./use-meal-texts";

/** In the compact week, each day lists this many meals before "+N more". */
const WEEK_DAY_MEALS = 3;

/**
 * The Meal planner widget's content: for a day, its slots in order with the meal in each (or an
 * Add button where the viewer may edit); for a week, each day with its meals in short. Meals open
 * the same dialog as the planner. Read again on focus and every minute.
 */
export function MealWidgetBody({
  homeId,
  initialPlan,
  mode,
}: {
  readonly homeId: string | null;
  readonly initialPlan: MealPlan;
  readonly mode: "today" | "day" | "week";
}) {
  const t = useTranslations("Meals");
  const locale = useLocale();
  const texts = useMealTexts();
  const plan = useMealPlan(homeId, initialPlan);
  const [target, setTarget] = useState<MealDialogTarget | null>(null);
  const editable = plan.access !== "view";
  const meals: PlannedMeal[] = [...plan.entries, ...plan.occurrences];
  const cells = groupByCell<PlannedMeal>(meals);
  const days = Array.from({ length: daysBetween(plan.from, plan.to) + 1 }, (_, index) =>
    addDays(plan.from, index),
  );
  const open = (meal: PlannedMeal) => {
    setTarget(meal.kind === "entry" ? { mode: "entry", meal } : { mode: "occurrence", meal });
  };
  const title = (meal: PlannedMeal) => (
    <span className={cx(meal.type === "recipe" && meal.recipe === null && "italic text-fg-muted")}>
      <bdi>{texts.mealTitle(meal)}</bdi>
      {meal.kind === "occurrence" ? (
        <RepeatIcon aria-label={t("repeatingMark")} className="ms-1 inline size-3.5" />
      ) : null}
    </span>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="meal-widget">
      {mode === "week" ? (
        <ul className="flex flex-col gap-2">
          {days.map((day) => {
            const planned = shownSlots(
              plan.slots,
              meals.filter((meal) => meal.date === day),
            ).flatMap((slot) => cells.get(cellKey(day, slot.id)) ?? []);
            const more = planned.length - WEEK_DAY_MEALS;
            return (
              <li key={day} className="flex flex-col">
                <span
                  className={cx(
                    "text-helper font-medium",
                    day === plan.today ? "text-accent-fg" : "text-fg-muted",
                  )}
                >
                  {formatMealDate(day, locale, "short")}
                </span>
                {planned.length === 0 ? (
                  <span className="text-helper text-fg-muted">{t("nothingPlanned")}</span>
                ) : (
                  <span className="flex flex-wrap gap-x-2 text-body">
                    {planned.slice(0, WEEK_DAY_MEALS).map((meal) => (
                      <button
                        key={mealKey(meal)}
                        type="button"
                        className="text-start hover:underline"
                        aria-haspopup="dialog"
                        onClick={() => {
                          open(meal);
                        }}
                      >
                        {title(meal)}
                      </button>
                    ))}
                    {more > 0 ? (
                      <span className="text-helper text-fg-muted">
                        {t("moreMeals", { count: more })}
                      </span>
                    ) : null}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <>
          <p className="text-helper font-medium text-fg-muted">
            {plan.from === plan.today ? t("todayBadge") : formatMealDate(plan.from, locale)}
          </p>
          <ul className="flex flex-col gap-2">
            {shownSlots(plan.slots, meals).map((slot) => {
              const planned = cells.get(cellKey(plan.from, slot.id)) ?? [];
              return (
                <li key={slot.id} className="flex flex-col">
                  <span className="text-helper text-fg-muted">
                    <bdi>{texts.slotName(slot)}</bdi>
                    {planned.length > 1 ? (
                      <span className="ms-2 inline-flex items-center gap-1 text-warning">
                        <WarningIcon aria-hidden="true" className="size-3.5" />
                        {t("unresolvedConflict")}
                      </span>
                    ) : null}
                  </span>
                  {planned.map((meal) => (
                    <button
                      key={mealKey(meal)}
                      type="button"
                      className="text-start text-body hover:underline"
                      aria-haspopup="dialog"
                      onClick={() => {
                        open(meal);
                      }}
                    >
                      {title(meal)}
                    </button>
                  ))}
                  {planned.length === 0 ? (
                    editable && slot.enabled ? (
                      <button
                        type="button"
                        className="self-start text-helper font-medium text-accent-fg underline"
                        aria-label={t("addMealTo", {
                          slot: texts.slotName(slot),
                          date: formatMealDate(plan.from, locale),
                        })}
                        onClick={() => {
                          setTarget({ mode: "new", date: plan.from, slotId: slot.id });
                        }}
                      >
                        {t("addMeal")}
                      </button>
                    ) : (
                      <span className="text-helper text-fg-muted">{t("nothingPlanned")}</span>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <Link
        href={`${mealsPath(homeId)}?date=${plan.from}`}
        className="text-body font-medium text-accent-fg underline"
      >
        {t("openPlanner")}
      </Link>
      {target ? (
        <MealDialog
          target={target}
          plan={plan}
          homeId={homeId}
          onClose={() => {
            setTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
