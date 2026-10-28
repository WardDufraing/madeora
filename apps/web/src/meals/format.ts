import { addDays, weekDates, weekStartOf, type MealWeekStart } from "@madeora/domain/meals";

import type { MealSlot, PlannedMeal } from "./api";

/** Client-safe helpers of the meal planner (S27). */

/** The planner of a context: the Personal space (`null`) or a Home, or one of its pages. */
export function mealsPath(
  homeId: string | null,
  page?: "settings" | "copy" | "shopping" | "print",
): string {
  const base = homeId ? `/homes/${homeId}/meals` : "/meals";
  return page ? `${base}/${page}` : base;
}

/** TanStack Query keys: everything under `all`, so one invalidation refreshes every meal view. */
export const mealKeys = {
  all: ["meals"] as const,
  plan: (homeId: string | null, from: string, to: string) =>
    ["meals", "plan", homeId ?? "personal", from, to] as const,
  recipes: (homeId: string | null) => ["meals", "recipes", homeId ?? "personal"] as const,
};

/** The days a week view shows: the week holding `date`, from the viewer's first weekday. */
export function weekOf(date: string, weekStart: MealWeekStart): readonly string[] {
  return weekDates(weekStartOf(date, weekStart));
}

export function previousWeek(start: string): string {
  return addDays(start, -7);
}

export function nextWeek(start: string): string {
  return addDays(start, 7);
}

/** The slots a day shows: enabled ones in order, and disabled ones that still hold a meal. */
export function shownSlots(
  slots: readonly MealSlot[],
  meals: readonly PlannedMeal[],
): readonly MealSlot[] {
  const used = new Set(meals.map((meal) => meal.slotId));
  return [...slots]
    .filter((slot) => slot.enabled || used.has(slot.id))
    .sort((a, b) => a.position - b.position);
}

/** A meal's stable React key and identity in the plan. */
export function mealKey(meal: PlannedMeal): string {
  return meal.kind === "entry" ? `e:${meal.id}` : `o:${meal.recurrenceId}:${meal.date}`;
}

/** A calendar date in the viewer's language, never converted through their timezone. */
export function formatMealDate(
  date: string,
  locale: string,
  style: "long" | "short" | "weekday" = "long",
): string {
  const options: Intl.DateTimeFormatOptions =
    style === "weekday"
      ? { weekday: "short", timeZone: "UTC" }
      : style === "short"
        ? { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }
        : { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" };
  return new Intl.DateTimeFormat(locale, options).format(new Date(`${date}T00:00:00Z`));
}

/** A new client id for a meal, series, slot, copy or transfer, so a retry never makes two. */
export function newId(): string {
  return crypto.randomUUID();
}
