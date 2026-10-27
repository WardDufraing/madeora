import { useTranslations } from "next-intl";

import { totalMinutes } from "@madeora/domain/recipes";

import { splitMinutes } from "@/recipes/format";

/** Minutes as "1 h 30 min" in the viewer's language. */
export function useDuration(): (minutes: number) => string {
  const t = useTranslations("Recipes");
  return (minutes) => {
    const { hours, minutes: rest } = splitMinutes(minutes);
    if (hours === 0) return t("durationMinutes", { minutes: rest });
    if (rest === 0) return t("durationHours", { hours });
    return t("durationHoursMinutes", { hours, minutes: rest });
  };
}

export interface RecipeTimesProps {
  readonly prepMinutes: number | null;
  readonly cookMinutes: number | null;
}

/**
 * Preparation and cooking time as recorded, and their total only when both are known (spec: an
 * unambiguous total only). Nothing when neither is recorded.
 */
export function RecipeTimes({ prepMinutes, cookMinutes }: RecipeTimesProps) {
  const t = useTranslations("Recipes");
  const duration = useDuration();
  const total = totalMinutes(prepMinutes, cookMinutes);
  const parts = [
    prepMinutes !== null ? t("prepTime", { time: duration(prepMinutes) }) : null,
    cookMinutes !== null ? t("cookTime", { time: duration(cookMinutes) }) : null,
    total !== null ? t("totalTime", { time: duration(total) }) : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-helper text-fg-muted">
      {parts.map((part) => (
        <li key={part}>{part}</li>
      ))}
    </ul>
  );
}

export interface RatingSummaryProps {
  readonly average: number | null;
  readonly count: number;
}

/** The context's average and how many ratings it is over; "Not rated yet" without any. */
export function RatingSummary({ average, count }: RatingSummaryProps) {
  const t = useTranslations("Recipes");
  if (average === null || count === 0) {
    return <span className="text-helper text-fg-muted">{t("notRated")}</span>;
  }
  return (
    <span className="text-helper text-fg-muted">
      {t("ratingSummary", { average: Math.round(average * 10) / 10, count })}
    </span>
  );
}
