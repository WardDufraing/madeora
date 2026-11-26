"use client";

import { useQueries } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import Link from "next/link";

import {
  addDays,
  habitMonthGrid,
  habitWeekdayOrder,
  type HabitWeekStart,
} from "@madeora/domain/habits";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { LoadingState } from "@/components/ui/states";
import {
  habitEndpoint,
  sendHabitRequest,
  type HabitCalendar,
  type HabitSummary,
} from "@/habits/api";
import { completionRate, formatWeekday, habitKeys, habitsPath } from "@/habits/format";

import { stateMark, stateTone } from "./habit-day-marks";
import { useHabitTexts } from "./use-habit-texts";

type DayTotal = "none" | "future" | "done" | "partial" | "missed" | "pending";

interface Tally {
  readonly completed: number;
  readonly eligible: number;
}

/** A habit's own day, counted for the history: completed, or scheduled and not (yet) done. */
function tallyDay(state: string): "completed" | "missed" | "pending" | null {
  if (state === "completed") return "completed";
  if (state === "missed") return "missed";
  if (state === "pending") return "pending";
  return null;
}

/**
 * Combines the habits' months into one cell per day: all done, some done, none done (missed, or
 * still pending today), nothing scheduled, or upcoming. Upcoming days are never counted against
 * anyone, and a day with nothing scheduled is neither done nor missed.
 */
export function combineDays(calendars: readonly HabitCalendar[]): Map<string, DayTotal> {
  const days = new Map<string, { completed: number; missed: number; pending: number }>();
  const future = new Set<string>();
  for (const calendar of calendars) {
    for (const day of calendar.days) {
      if (day.state === "future") future.add(day.onDate);
      const kind = tallyDay(day.state);
      if (!kind) continue;
      const entry = days.get(day.onDate) ?? { completed: 0, missed: 0, pending: 0 };
      entry[kind] += 1;
      days.set(day.onDate, entry);
    }
  }
  const result = new Map<string, DayTotal>();
  for (const date of future) if (!days.has(date)) result.set(date, "future");
  for (const [date, entry] of days) {
    const eligible = entry.completed + entry.missed + entry.pending;
    result.set(
      date,
      entry.completed === eligible
        ? "done"
        : entry.completed > 0
          ? "partial"
          : entry.pending > 0 && entry.missed === 0
            ? "pending"
            : "missed",
    );
  }
  return result;
}

/** Completed and eligible (not pending, not upcoming) scheduled days of one month. */
export function tallyMonth(calendar: HabitCalendar): Tally {
  let completed = 0;
  let eligible = 0;
  for (const day of calendar.days) {
    if (day.state === "completed") {
      completed += 1;
      eligible += 1;
    } else if (day.state === "missed") eligible += 1;
  }
  return { completed, eligible };
}

const totalMark: Record<DayTotal, string> = {
  done: stateMark.completed,
  partial: "\u{25D0}",
  missed: stateMark.missed,
  pending: stateMark.pending,
  none: stateMark.not_scheduled,
  future: "",
};

const totalTone: Record<DayTotal, string> = {
  done: stateTone.completed,
  partial: "bg-accent-subtle/50 text-fg",
  missed: stateTone.missed,
  pending: stateTone.pending,
  none: stateTone.not_scheduled,
  future: stateTone.future,
};

export interface HabitTrendsProps {
  readonly habits: readonly HabitSummary[];
  readonly homeId: string | null;
  readonly today: string;
  readonly weekStart: HabitWeekStart;
}

/**
 * The optional trends view (redesign decision 66): compact summary measures, a calendar of the
 * habits' days and a short list for opening one habit's own history. It reads each habit's month
 * with the habit's own permission (the same read as its page), so it shows what the viewer may see.
 * Every day has a text name and a mark, an upcoming day is neutral, and a missed day is plain, not
 * alarming. A month selector moves through history. Everything also reads as a list.
 */
export function HabitTrends({ habits, homeId, today, weekStart }: HabitTrendsProps) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const locale = useLocale();
  const dayName = (total: DayTotal) => {
    switch (total) {
      case "done":
        return t("trendsDay_done");
      case "partial":
        return t("trendsDay_partial");
      case "missed":
        return t("trendsDay_missed");
      case "pending":
        return t("trendsDay_pending");
      case "none":
        return t("trendsDay_none");
      case "future":
        return t("trendsDay_future");
    }
  };
  const [month, setMonth] = useState(today.slice(0, 7));
  const tracked = habits.filter((habit) => habit.status === "active" || habit.status === "paused");
  const queries = useQueries({
    queries: tracked.map((habit) => ({
      queryKey: habitKeys.calendar(habit.id, month),
      queryFn: () =>
        sendHabitRequest<{ calendar: HabitCalendar }>(
          "GET",
          `${habitEndpoint(habit.id, "calendar")}?month=${month}`,
        ),
      staleTime: 30_000,
    })),
  });
  const first = `${month}-01`;
  const label = texts.date(first, "month");
  const loaded = queries.every((query) => query.data);
  const failed = queries.some((query) => query.isError);
  const calendars = queries.flatMap((query) => (query.data ? [query.data.calendar] : []));
  const perHabit = tracked.map((habit, index) => {
    const calendar = queries[index]?.data?.calendar;
    return { habit, tally: calendar ? tallyMonth(calendar) : null };
  });
  const total = perHabit.reduce(
    (sum, row) => ({
      completed: sum.completed + (row.tally?.completed ?? 0),
      eligible: sum.eligible + (row.tally?.eligible ?? 0),
    }),
    { completed: 0, eligible: 0 },
  );
  const rate = completionRate(total.completed, total.eligible);
  const days = combineDays(calendars);
  const longest = Math.max(0, ...tracked.map((habit) => habit.streak.longestOccurrences));
  return (
    <div className="flex flex-col gap-4" data-testid="habit-trends">
      <Card title={t("trendsTitle")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-body font-semibold text-fg" aria-live="polite">
              {label}
            </h3>
            <Button
              size="sm"
              variant="secondary"
              aria-label={t("previousMonth")}
              onClick={() => {
                setMonth(addDays(first, -1).slice(0, 7));
              }}
            >
              {"\u{2039}"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-label={t("nextMonth")}
              onClick={() => {
                setMonth(addDays(first, 31).slice(0, 7));
              }}
            >
              {"\u{203A}"}
            </Button>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="habit-trends-metrics">
            <div className="flex flex-col gap-0.5 rounded-control bg-surface-sunken p-3">
              <dt className="text-helper text-fg-muted">{t("trendsConsistency")}</dt>
              <dd className="text-section-title font-semibold text-fg">
                {rate === null ? t("trendsNoRate") : t("trendsRate", { percent: rate })}
              </dd>
              <dd className="text-helper text-fg-muted">
                {t("trendsRateDetail", { completed: total.completed, eligible: total.eligible })}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5 rounded-control bg-surface-sunken p-3">
              <dt className="text-helper text-fg-muted">{t("trendsHabits")}</dt>
              <dd className="text-section-title font-semibold text-fg">{tracked.length}</dd>
            </div>
            <div className="flex flex-col gap-0.5 rounded-control bg-surface-sunken p-3">
              <dt className="text-helper text-fg-muted">{t("trendsLongest")}</dt>
              <dd className="text-section-title font-semibold text-fg">
                {t("trendsLongestValue", { count: longest })}
              </dd>
            </div>
          </dl>
          {failed ? <p className="text-body text-danger">{t("trendsFailed")}</p> : null}
          {!loaded && !failed ? (
            <LoadingState label={t("loading")} />
          ) : (
            <>
              <table className="w-full max-w-md table-fixed border-collapse text-center">
                <caption className="sr-only">{t("trendsCaption", { month: label })}</caption>
                <thead>
                  <tr>
                    {habitWeekdayOrder(weekStart).map((day) => (
                      <th
                        key={day}
                        scope="col"
                        className="p-1 text-helper font-medium text-fg-muted"
                      >
                        <abbr title={formatWeekday(day, locale, "long")} className="no-underline">
                          {formatWeekday(day, locale)}
                        </abbr>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {habitMonthGrid(month, weekStart).map((week, index) => (
                    <tr key={week.find((day) => day !== null) ?? index}>
                      {week.map((date, column) => {
                        const dayTotal = date ? (days.get(date) ?? "none") : null;
                        return (
                          <td key={date ?? `empty-${String(column)}`} className="p-0.5">
                            {date && dayTotal ? (
                              <span
                                className={cx(
                                  "flex min-h-10 flex-col items-center justify-center rounded-control text-helper",
                                  totalTone[dayTotal],
                                )}
                                aria-current={date === today ? "date" : undefined}
                                data-state={dayTotal}
                              >
                                <span>{Number(date.slice(8))}</span>
                                <span aria-hidden="true">{totalMark[dayTotal]}</span>
                                <span className="sr-only">{dayName(dayTotal)}</span>
                              </span>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-helper text-fg-muted">
                {t("trendsLegend", {
                  done: totalMark.done,
                  partial: totalMark.partial,
                  missed: totalMark.missed,
                  open: totalMark.pending,
                  none: totalMark.none,
                })}
              </p>
            </>
          )}
        </div>
      </Card>
      <Card title={t("trendsByHabit")} headingLevel={2}>
        <ul className="flex flex-col divide-y divide-line" data-testid="habit-trends-habits">
          {perHabit.map(({ habit, tally }) => {
            const percent = tally ? completionRate(tally.completed, tally.eligible) : null;
            return (
              <li
                key={habit.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-body font-medium text-fg [overflow-wrap:anywhere]">
                    <bdi>{habit.name}</bdi>
                  </span>
                  <span className="text-helper text-fg-muted">
                    {percent === null
                      ? t("trendsNoRate")
                      : t("trendsHabitRate", {
                          percent,
                          completed: tally?.completed ?? 0,
                          eligible: tally?.eligible ?? 0,
                        })}
                  </span>
                </div>
                <Link
                  href={habitsPath(homeId, habit.id)}
                  className="text-body link-action"
                  aria-label={t("trendsOpenHabit", { habit: habit.name })}
                >
                  {t("trendsOpen")}
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
