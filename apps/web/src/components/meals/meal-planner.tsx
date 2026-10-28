"use client";

import { RepeatIcon, WarningIcon } from "@madeora/icons";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import {
  addDays,
  cellKey,
  groupByCell,
  weekDates,
  type MealWeekStart,
} from "@madeora/domain/meals";

import { secondaryLinkClass } from "@/components/recipes/link-styles";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { MEAL_PLAN_ENDPOINT, sendMealRequest, type MealPlan, type PlannedMeal } from "@/meals/api";
import { formatMealDate, mealKey, mealKeys, mealsPath, shownSlots, weekOf } from "@/meals/format";
import { recipesPath } from "@/recipes/format";

import { MealDialog, type MealDialogTarget } from "./meal-dialog";
import { MealSeriesList } from "./meal-series-list";
import { useMealTexts } from "./use-meal-texts";

/** The plan is read again this often while the page is visible (no Realtime for the planner). */
const REFRESH_INTERVAL_MS = 60_000;

export interface MealPlannerProps {
  readonly homeId: string | null;
  /** The Home's name, or "Personal space", shown above the plan. */
  readonly context: string;
  readonly initialPlan: MealPlan;
  readonly view: "week" | "day";
  /** The day shown, or a day of the week shown. */
  readonly date: string;
  readonly weekStart: MealWeekStart;
}

/** Reads the plan of the shown dates again on focus, every minute and after each change. */
export function useMealPlan(homeId: string | null, initialPlan: MealPlan): MealPlan {
  const query = useQuery<{ plan: MealPlan }>({
    queryKey: mealKeys.plan(homeId, initialPlan.from, initialPlan.to),
    queryFn: () => {
      const search = new URLSearchParams({ from: initialPlan.from, to: initialPlan.to });
      if (homeId) search.set("homeId", homeId);
      return sendMealRequest("GET", `${MEAL_PLAN_ENDPOINT}?${search.toString()}`);
    },
    initialData: { plan: initialPlan },
    staleTime: 30_000,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  return query.data.plan;
}

/**
 * The meal planner of one context (S27): a week (from the viewer's first weekday) or one day, each
 * day with its slots in order and what is planned in them. Recipe meals, custom meals, unavailable
 * recipes and repeating meals are told apart in text, not by colour alone; a slot holding two meals
 * (a repeating meal that met another) is flagged as an unresolved conflict. People who may edit the
 * plan add a meal from an empty slot and open a meal to edit, move or remove it.
 */
export function MealPlanner({
  homeId,
  context,
  initialPlan,
  view,
  date,
  weekStart,
}: MealPlannerProps) {
  const t = useTranslations("Meals");
  const locale = useLocale();
  const plan = useMealPlan(homeId, initialPlan);
  const [target, setTarget] = useState<MealDialogTarget | null>(null);
  const editable = plan.access !== "view";
  const days = view === "day" ? [date] : weekDates(weekOf(date, weekStart)[0] ?? date);
  const cells = groupByCell<PlannedMeal>([...plan.entries, ...plan.occurrences]);
  const base = mealsPath(homeId);
  const step = view === "day" ? 1 : 7;
  const at = (day: string, shown: "week" | "day" = view) =>
    `${base}?date=${day}${shown === "day" ? "&view=day" : ""}`;

  return (
    <div className="flex flex-col gap-6" data-testid="meal-planner">
      <p className="flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{context}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={recipesPath(homeId)} className="font-medium text-accent-fg underline">
          {t("recipesLink")}
        </Link>
        {plan.access === "view" ? (
          <>
            <span aria-hidden="true">{"\u{00B7}"}</span>
            <span>{t("viewOnly")}</span>
          </>
        ) : null}
      </p>
      <nav aria-label={t("dateNavigation")} className="flex flex-wrap items-center gap-2">
        <Link
          href={at(addDays(date, -step))}
          className={secondaryLinkClass}
          data-testid="meal-previous"
        >
          {view === "day" ? t("previousDay") : t("previousWeek")}
        </Link>
        <Link href={at(plan.today)} className={secondaryLinkClass}>
          {view === "day" ? t("today") : t("thisWeek")}
        </Link>
        <Link href={at(addDays(date, step))} className={secondaryLinkClass} data-testid="meal-next">
          {view === "day" ? t("nextDay") : t("nextWeek")}
        </Link>
        <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
        <Link
          href={at(date, "week")}
          aria-current={view === "week" ? "page" : undefined}
          className={cx(secondaryLinkClass, view === "week" && "bg-accent-subtle")}
        >
          {t("weekView")}
        </Link>
        <Link
          href={at(date, "day")}
          aria-current={view === "day" ? "page" : undefined}
          className={cx(secondaryLinkClass, view === "day" && "bg-accent-subtle")}
          data-testid="meal-day-view"
        >
          {t("dayView")}
        </Link>
      </nav>
      <div className="flex flex-wrap gap-2">
        {editable ? (
          <>
            <Link
              href={`${mealsPath(homeId, "copy")}?date=${date}`}
              className={secondaryLinkClass}
              data-testid="meal-copy-link"
            >
              {t("copyWeek")}
            </Link>
            <Link
              href={`${mealsPath(homeId, "shopping")}?date=${date}`}
              className={secondaryLinkClass}
              data-testid="meal-transfer-link"
            >
              {t("addToShopping")}
            </Link>
          </>
        ) : null}
        <Link
          href={`${mealsPath(homeId, "print")}?date=${date}`}
          className={secondaryLinkClass}
          data-testid="meal-print-link"
        >
          {t("print")}
        </Link>
        <Link
          href={mealsPath(homeId, "settings")}
          className={secondaryLinkClass}
          data-testid="meal-settings-link"
        >
          {plan.access === "manage" ? t("slotsAndSettings") : t("slots")}
        </Link>
      </div>
      <div
        className={cx("grid gap-4", view === "week" && "md:grid-cols-2 xl:grid-cols-3")}
        data-testid="meal-days"
      >
        {days.map((day) => {
          const meals = [...plan.entries, ...plan.occurrences].filter((meal) => meal.date === day);
          const slots = shownSlots(plan.slots, meals);
          const headingId = `meal-day-${day}`;
          return (
            <section
              key={day}
              aria-labelledby={headingId}
              className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
              data-testid={`meal-day-${day}`}
            >
              <h2
                id={headingId}
                className="flex flex-wrap items-center gap-2 text-section-title font-semibold"
              >
                {formatMealDate(day, locale)}
                {day === plan.today ? (
                  <span className="rounded-full bg-accent-subtle px-2 text-helper font-medium text-accent-fg">
                    {t("todayBadge")}
                  </span>
                ) : null}
              </h2>
              {slots.length === 0 ? (
                <p className="text-helper text-fg-muted">{t("noSlots")}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {slots.map((slot) => (
                    <SlotRow
                      key={slot.id}
                      slotName={slot}
                      enabled={slot.enabled}
                      meals={cells.get(cellKey(day, slot.id)) ?? []}
                      editable={editable}
                      date={day}
                      locale={locale}
                      onAdd={() => {
                        setTarget({ mode: "new", date: day, slotId: slot.id });
                      }}
                      onOpen={(meal) => {
                        setTarget(
                          meal.kind === "entry"
                            ? { mode: "entry", meal }
                            : { mode: "occurrence", meal },
                        );
                      }}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <MealSeriesList
        plan={plan}
        homeId={homeId}
        onEdit={(series) => {
          setTarget({
            mode: "series",
            series,
            from: series.startOn > plan.today ? series.startOn : plan.today,
          });
        }}
      />
      {target ? (
        <MealDialog
          key={
            target.mode === "new"
              ? `new:${target.date}:${target.slotId}`
              : target.mode === "series"
                ? `s:${target.series.id}`
                : mealKey(target.meal)
          }
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

function SlotRow({
  slotName,
  enabled,
  meals,
  editable,
  date,
  locale,
  onAdd,
  onOpen,
}: {
  readonly slotName: Parameters<ReturnType<typeof useMealTexts>["slotName"]>[0];
  readonly enabled: boolean;
  readonly meals: readonly PlannedMeal[];
  readonly editable: boolean;
  readonly date: string;
  readonly locale: string;
  readonly onAdd: () => void;
  readonly onOpen: (meal: PlannedMeal) => void;
}) {
  const t = useTranslations("Meals");
  const texts = useMealTexts();
  const name = texts.slotName(slotName);
  return (
    <li className="flex flex-col gap-1 border-t border-line pt-2 first:border-t-0 first:pt-0">
      <span className="text-helper font-medium text-fg-muted">
        <bdi>{name}</bdi>
        {!enabled ? (
          <span>
            {" "}
            {"\u{00B7}"} {t("slotDisabled")}
          </span>
        ) : null}
      </span>
      {meals.length > 1 ? (
        <p
          className="flex items-center gap-1 text-helper font-medium text-warning"
          data-testid="meal-conflict"
        >
          <WarningIcon aria-hidden="true" className="size-4" />
          {t("unresolvedConflict")}
        </p>
      ) : null}
      {meals.map((meal) => (
        <MealButton key={mealKey(meal)} meal={meal} editable={editable} onOpen={onOpen} />
      ))}
      {meals.length === 0 ? (
        editable && enabled ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            aria-label={t("addMealTo", { slot: name, date: formatMealDate(date, locale) })}
            onClick={onAdd}
            data-testid="meal-add"
          >
            {t("addMeal")}
          </Button>
        ) : (
          <span className="text-helper text-fg-muted">{t("nothingPlanned")}</span>
        )
      ) : null}
    </li>
  );
}

function MealButton({
  meal,
  editable,
  onOpen,
}: {
  readonly meal: PlannedMeal;
  readonly editable: boolean;
  readonly onOpen: (meal: PlannedMeal) => void;
}) {
  const t = useTranslations("Meals");
  const texts = useMealTexts();
  const unavailable = meal.type === "recipe" && meal.recipe === null;
  return (
    <button
      type="button"
      className="flex flex-col items-start rounded-control px-2 py-1 text-start hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      onClick={() => {
        onOpen(meal);
      }}
      aria-haspopup="dialog"
      data-testid="meal-item"
    >
      <span className={cx("text-body font-medium text-fg", unavailable && "italic text-fg-muted")}>
        <bdi>{texts.mealTitle(meal)}</bdi>
      </span>
      <span className="flex flex-wrap items-center gap-x-2 text-helper text-fg-muted">
        <span>{meal.type === "custom" ? t("customMark") : t("recipeMark")}</span>
        {meal.kind === "occurrence" ? (
          <span className="flex items-center gap-1">
            <RepeatIcon aria-hidden="true" className="size-3.5" />
            {t("repeatingMark")}
          </span>
        ) : null}
        {meal.servings !== null ? <span>{t("servingsMark", { count: meal.servings })}</span> : null}
        {!editable ? null : <span className="sr-only">{t("openToEdit")}</span>}
      </span>
    </button>
  );
}
