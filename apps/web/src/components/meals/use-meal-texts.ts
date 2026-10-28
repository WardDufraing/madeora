"use client";

import { useTranslations } from "next-intl";

import type { MealStandardSlot } from "@madeora/domain/meals";

import type { MealFailure, MealSeries, MealSlot, PlannedMeal } from "@/meals/api";

const failureKey = {
  signedOut: "failureSignedOut",
  invalid: "failureInvalid",
  notFound: "failureNotFound",
  notPermitted: "failureNotPermitted",
  conflict: "failureConflict",
  idTaken: "failureFailed",
  occupied: "failureOccupied",
  conflicts: "failureConflicts",
  stale: "failureStale",
  impactRequired: "failureImpactRequired",
  slotUnavailable: "failureSlotUnavailable",
  recipeUnavailable: "failureRecipeUnavailable",
  invalidDate: "failureInvalidDate",
  nameTaken: "failureNameTaken",
  limitReached: "failureLimitReached",
  listUnavailable: "failureListUnavailable",
  network: "failureNetwork",
  failed: "failureFailed",
} as const satisfies Record<MealFailure, string>;

const standardKey = {
  breakfast: "slotBreakfast",
  lunch: "slotLunch",
  dinner: "slotDinner",
} as const satisfies Record<MealStandardSlot, string>;

const fieldKey = {
  required: "fieldRequired",
  tooLong: "fieldTooLong",
  invalidCharacters: "fieldInvalidCharacters",
  weekdaysRequired: "fieldWeekdaysRequired",
  recipeRequired: "fieldRecipeRequired",
  servings: "fieldServings",
  endBeforeStart: "fieldEndBeforeStart",
  invalid: "fieldInvalid",
} as const;
type FieldError = keyof typeof fieldKey;

function isFieldError(code: string): code is FieldError {
  return Object.hasOwn(fieldKey, code);
}

/** Texts of the meal planner in the viewer's language: slots, meals, schedules and failures. */
export function useMealTexts() {
  const t = useTranslations("Meals");
  const slotName = (slot: Pick<MealSlot, "name" | "standardKey"> | undefined): string => {
    if (!slot) return t("slotUnknown");
    if (slot.name !== null) return slot.name;
    return slot.standardKey ? t(standardKey[slot.standardKey]) : t("slotUnknown");
  };
  const mealTitle = (meal: Pick<PlannedMeal, "type" | "recipe" | "title">): string => {
    if (meal.type === "custom") return meal.title ?? "";
    return meal.recipe ? meal.recipe.name : t("recipeUnavailable");
  };
  const weekdayName = (weekday: number, locale: string, style: "long" | "short" = "long") =>
    // 2024-01-01 was a Monday, so day N of that week is ISO weekday N.
    new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" }).format(
      new Date(Date.UTC(2024, 0, weekday)),
    );
  const schedule = (series: Pick<MealSeries, "cadence" | "weekdays">, locale: string): string => {
    if (series.cadence === "daily") return t("cadenceDailyText");
    const days = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
      [...(series.weekdays ?? [])].sort((a, b) => a - b).map((day) => weekdayName(day, locale)),
    );
    return series.cadence === "weekly"
      ? t("cadenceWeeklyText", { days })
      : t("cadenceWeekdaysText", { days });
  };
  return {
    slotName,
    mealTitle,
    weekdayName,
    schedule,
    failure: (failure: MealFailure) => t(failureKey[failure]),
    field: (code: string | undefined) =>
      code === undefined ? undefined : t(isFieldError(code) ? fieldKey[code] : "fieldInvalid"),
  };
}
