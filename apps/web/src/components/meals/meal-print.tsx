"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cellKey, daysBetween, addDays, groupByCell, type PlacedMeal } from "@madeora/domain/meals";

import { FormAlert } from "@/components/auth/form-alert";
import { secondaryLinkClass } from "@/components/recipes/link-styles";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  MEAL_PLAN_ENDPOINT,
  MealRequestError,
  sendMealRequest,
  type MealPlan,
  type PlannedMeal,
} from "@/meals/api";
import { formatMealDate, mealKey, mealKeys, mealsPath, shownSlots } from "@/meals/format";

import { useMealTexts } from "./use-meal-texts";

export interface MealPrintProps {
  readonly homeId: string | null;
  readonly context: string;
  /** The week as previewed: what is printed, unless it changed before printing. */
  readonly plan: MealPlan;
}

type Check = "idle" | "checking" | "changed" | "unavailable" | "failed";

/**
 * The print view of one week (S27): its dates, the enabled slots in order (and disabled slots that
 * still hold a meal) and what is planned, recipe meals by their visible name or "Recipe unavailable".
 * Notes are left out unless the person includes them. Before printing, the week is read again with
 * the person's session: if it changed, they are told and may refresh instead of printing something
 * else than they saw. Nothing is exported or stored.
 */
export function MealPrint({ homeId, context, plan }: MealPrintProps) {
  const t = useTranslations("Meals");
  const locale = useLocale();
  const texts = useMealTexts();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [, startTransition] = useTransition();
  const [notes, setNotes] = useState(false);
  const [check, setCheck] = useState<Check>("idle");
  const days = Array.from({ length: daysBetween(plan.from, plan.to) + 1 }, (_, index) =>
    addDays(plan.from, index),
  );
  const meals: PlannedMeal[] = [...plan.entries, ...plan.occurrences];
  const cells = groupByCell<PlacedMeal & PlannedMeal>(meals);

  const print = async () => {
    setCheck("checking");
    try {
      const search = new URLSearchParams({ from: plan.from, to: plan.to });
      if (homeId) search.set("homeId", homeId);
      const current = await sendMealRequest<{ plan: MealPlan }>(
        "GET",
        `${MEAL_PLAN_ENDPOINT}?${search.toString()}`,
      );
      if (current.plan.token !== plan.token) {
        setCheck("changed");
        return;
      }
    } catch (error) {
      setCheck(
        error instanceof MealRequestError && error.failure === "notFound" ? "changed" : "failed",
      );
      return;
    }
    if (typeof window.print !== "function") {
      setCheck("unavailable");
      return;
    }
    setCheck("idle");
    window.print();
  };

  return (
    <div className="flex flex-col gap-5" data-print-view data-testid="meal-print">
      <div className="flex flex-col gap-3" data-print-hide>
        <FormAlert tone="info">{t("printPrivacy")}</FormAlert>
        <Checkbox
          label={t("printIncludeNotes")}
          checked={notes}
          onChange={(event) => {
            setNotes(event.target.checked);
          }}
          data-testid="meal-print-notes"
        />
        {check === "changed" ? (
          <FormAlert tone="error" announce>
            {t("printChanged")}{" "}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: mealKeys.all });
                setCheck("idle");
                startTransition(() => {
                  router.refresh();
                });
              }}
              data-testid="meal-print-refresh"
            >
              {t("refresh")}
            </Button>
          </FormAlert>
        ) : check === "unavailable" ? (
          <FormAlert tone="info" announce>
            {t("printUnavailable")}
          </FormAlert>
        ) : check === "failed" ? (
          <FormAlert tone="error" announce>
            {t("printCheckFailed")}
          </FormAlert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Link href={`${mealsPath(homeId)}?date=${plan.from}`} className={secondaryLinkClass}>
            {t("cancel")}
          </Link>
          <Button
            loading={check === "checking"}
            onClick={() => {
              void print();
            }}
            data-testid="meal-print-confirm"
          >
            {t("print")}
          </Button>
        </div>
      </div>
      <article className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4 print:border-0 print:p-0">
        <div className="flex flex-col">
          <h2 className="text-section-title font-semibold">
            {t("printHeading", {
              from: formatMealDate(plan.from, locale),
              to: formatMealDate(plan.to, locale),
            })}
          </h2>
          <p className="text-body text-fg-muted">
            <bdi>{context}</bdi>
          </p>
        </div>
        {meals.length === 0 ? <p className="text-body text-fg">{t("printEmptyWeek")}</p> : null}
        {days.map((day) => {
          const slots = shownSlots(
            plan.slots,
            meals.filter((meal) => meal.date === day),
          );
          return (
            <section
              key={day}
              data-print-day
              className="flex flex-col gap-1 border-t border-line pt-3"
            >
              <h3 className="text-body font-semibold text-fg">{formatMealDate(day, locale)}</h3>
              <dl className="grid gap-x-4 gap-y-1 text-body sm:grid-cols-[minmax(6rem,max-content)_1fr]">
                {slots.map((slot) => {
                  const planned = cells.get(cellKey(day, slot.id)) ?? [];
                  return (
                    <div key={slot.id} className="contents">
                      <dt className="font-medium text-fg">
                        <bdi>{texts.slotName(slot)}</bdi>
                      </dt>
                      <dd className="text-fg">
                        {planned.length === 0 ? (
                          <span className="text-fg-muted">{t("printNothing")}</span>
                        ) : (
                          <ul className="flex flex-col">
                            {planned.map((meal) => (
                              <li key={mealKey(meal)}>
                                <bdi>{texts.mealTitle(meal)}</bdi>
                                {meal.kind === "occurrence" ? ` (${t("repeatingMark")})` : ""}
                                {meal.servings !== null
                                  ? ` \u{00B7} ${t("servingsMark", { count: meal.servings })}`
                                  : ""}
                                {notes && meal.notes ? (
                                  <span className="block whitespace-pre-line text-helper">
                                    {meal.notes}
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          );
        })}
      </article>
    </div>
  );
}
