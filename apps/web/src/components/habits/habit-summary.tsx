"use client";

import { useTranslations } from "next-intl";

import { Card } from "@/components/ui/card";
import type { HabitSummary } from "@/habits/api";

import { useHabitTexts } from "./use-habit-texts";

/** A habit counts toward today when it is live and scheduled for a check-in or progress today. */
function countsToday(habit: HabitSummary): boolean {
  if (habit.status !== "active") return false;
  return habit.todayState !== "not_scheduled" && habit.todayState !== "untracked";
}

function isDoneToday(habit: HabitSummary): boolean {
  return habit.tracking.mode === "numeric"
    ? (habit.progress?.met ?? false)
    : habit.todayCheckin?.status === "active";
}

export interface TodaySummary {
  readonly done: number;
  readonly total: number;
  readonly best: HabitSummary | null;
}

/** Done and scheduled today, and the habit with the longest running streak. */
export function summarizeToday(habits: readonly HabitSummary[]): TodaySummary {
  const scheduled = habits.filter(countsToday);
  const best = habits.reduce<HabitSummary | null>(
    (top, habit) =>
      habit.streak.current > (top?.streak.current ?? 0) &&
      (habit.status === "active" || habit.status === "paused")
        ? habit
        : top,
    null,
  );
  return { done: scheduled.filter(isDoneToday).length, total: scheduled.length, best };
}

/**
 * The compact summary above the daily checklist (redesign decision 62): how many of today's
 * habits are done, as text and a progress bar, and the longest current streak. When everything
 * scheduled is done, a short inline message says so (decision 65): text only, no full-screen
 * moment, and only for people who keep celebrations on.
 */
export function HabitSummaryBand({
  habits,
  celebrations,
}: {
  readonly habits: readonly HabitSummary[];
  readonly celebrations: boolean;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const { done, total, best } = summarizeToday(habits);
  const finished = total > 0 && done === total;
  return (
    <div data-testid="habit-summary">
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p className="text-section-title font-semibold text-fg" data-testid="habit-summary-today">
            {total === 0 ? t("summaryNothingToday") : t("summaryDone", { done, total })}
          </p>
          {best ? (
            <p className="text-body text-fg-muted" data-testid="habit-summary-streak">
              {t("summaryBestStreak", { habit: best.name, streak: texts.streak(best.streak) })}
            </p>
          ) : null}
        </div>
        {total > 0 ? (
          <div
            aria-hidden="true"
            className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
          >
            <div
              className="h-full rounded-full bg-accent motion-safe:transition-[width] motion-safe:duration-300"
              style={{ width: `${String(Math.round((done / total) * 100))}%` }}
            />
          </div>
        ) : null}
        <p role="status" className="text-body text-fg" data-testid="habit-summary-milestone">
          {finished && celebrations ? t("summaryAllDone") : ""}
        </p>
      </Card>
    </div>
  );
}
