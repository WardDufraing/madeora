"use client";

import { useTranslations } from "next-intl";

import type { HabitNumericSummary } from "@/habits/api";

import { useHabitTexts } from "./use-habit-texts";
import { useNumericTexts } from "./use-numeric-texts";

type Period = HabitNumericSummary["periods"][number];

function PeriodList({
  title,
  periods,
}: {
  readonly title: string;
  readonly periods: readonly Period[];
}) {
  const t = useTranslations("HabitsNumeric");
  const texts = useHabitTexts();
  const numeric = useNumericTexts();
  if (periods.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-body font-semibold text-fg">{title}</h4>
      <ol className="flex flex-col gap-2 text-body text-fg">
        {periods.map((period) => (
          <li key={`${period.kind}-${period.startsOn}`} className="flex flex-col gap-0.5">
            <span className="font-medium">
              {t("periodRange", {
                from: texts.date(period.startsOn, "short"),
                to: texts.date(period.endsOn, "short"),
              })}
              {period.soFar ? ` · ${t("soFar")}` : ""}
            </span>
            {period.segments.length === 0 ? (
              <span className="text-helper text-fg-muted">{t("periodNoDays")}</span>
            ) : (
              period.segments.map((segment) => (
                <span
                  key={`${segment.unitKind}-${segment.unit}`}
                  className="text-helper text-fg-muted"
                >
                  {t("segmentText", {
                    total: numeric.amount(segment.total, segment.unit, segment.unitKind),
                    average: numeric.amount(segment.average, segment.unit, segment.unitKind),
                    met: segment.metDays,
                    eligible: segment.eligibleDays,
                  })}
                </span>
              ))
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Weekly and monthly quantity summaries of a numeric habit: the total, the average per eligible day
 * (days off the schedule, paused or not yet begun are left out) and how many days met their own
 * target. Units that cannot be added up are listed apart, never mixed.
 */
export function NumericSummaries({ summary }: { readonly summary: HabitNumericSummary }) {
  const t = useTranslations("HabitsNumeric");
  return (
    <div className="flex flex-col gap-3" data-testid="habit-numeric-summaries">
      <h3 className="text-body font-semibold text-fg">{t("summariesTitle")}</h3>
      <PeriodList
        title={t("weeksTitle")}
        periods={summary.periods.filter((p) => p.kind === "week")}
      />
      <PeriodList
        title={t("monthsTitle")}
        periods={summary.periods.filter((p) => p.kind === "month")}
      />
    </div>
  );
}
