"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";

import { addDays, habitWeekOf, isoWeekday, type HabitDayState } from "@madeora/domain/habits";

import { cx } from "@/components/ui/cx";
import { habitEndpoint, sendHabitRequest, type HabitDetail, type HabitSummary } from "@/habits/api";
import { formatWeekday, habitKeys } from "@/habits/format";

import { stateMark, stateTone } from "./habit-day-marks";
import { useHabitTexts } from "./use-habit-texts";
import { useNumericTexts } from "./use-numeric-texts";

/** The strip's cell states: the habit's own day states plus a partial numeric day. */
type CellState = HabitDayState | "partial";

const WEEK_DAYS = 7;

export interface WeekCell {
  readonly date: string;
  readonly state: CellState;
  /** 0 to 1, for a numeric day's proportional fill. */
  readonly fraction: number | null;
  /** The numeric day, when the habit is tracked by a quantity. */
  readonly numeric: HabitDetail["numericRecent"][number] | null;
}

/**
 * The seven days of the habit's current week (its own week start), from the habit's recent days.
 * A day after today is upcoming, never missed; a past day the habit has no state for stays
 * untracked. A numeric day is partial while it has progress short of its target.
 */
export function weekCells(
  habit: Pick<HabitSummary, "today" | "weekStart">,
  detail: Pick<HabitDetail, "recent" | "numericRecent">,
): WeekCell[] {
  const first = habitWeekOf(habit.today, habit.weekStart);
  const days = new Map(detail.recent.map((day) => [day.onDate, day]));
  const numeric = new Map(detail.numericRecent.map((day) => [day.onDate, day]));
  return Array.from({ length: WEEK_DAYS }, (_, index) => {
    const date = addDays(first, index);
    if (date > habit.today) return { date, state: "future", fraction: null, numeric: null };
    const day = days.get(date);
    const quantity = numeric.get(date) ?? null;
    const state: CellState = day?.state ?? "untracked";
    if (quantity && state !== "not_scheduled" && state !== "untracked" && state !== "paused") {
      const fraction = quantity.target > 0 ? Math.min(quantity.total / quantity.target, 1) : 0;
      if (quantity.met) return { date, state: "completed", fraction: 1, numeric: quantity };
      if (quantity.total > 0) return { date, state: "partial", fraction, numeric: quantity };
      return { date, state, fraction: 0, numeric: quantity };
    }
    return { date, state, fraction: null, numeric: quantity };
  });
}

/** Reads one habit's recent days (the same read as its page) for the strip. */
function useHabitWeek(habit: HabitSummary) {
  return useQuery<{ habit: HabitDetail }>({
    queryKey: [...habitKeys.all, "week", habit.id, habit.today],
    queryFn: () => sendHabitRequest("GET", habitEndpoint(habit.id)),
    staleTime: 30_000,
  });
}

/**
 * A consistent seven-day strip for one habit (redesign decision 64): a check mark per completed
 * day for habits completed once, a proportional fill for a quantity against its target, and a
 * distinct mark and text for partial, missed, paused, not scheduled and upcoming days. Every cell
 * has a text name, so colour is never the only signal, and upcoming days are not failures.
 */
export function HabitWeekStrip({ habit }: { readonly habit: HabitSummary }) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const numericTexts = useNumericTexts();
  const locale = useLocale();
  const week = useHabitWeek(habit);
  if (week.isError) {
    return (
      <p className="text-helper text-danger" data-testid="habit-week-strip-failed">
        {t("weekStripFailed")}
      </p>
    );
  }
  if (!week.data) {
    return (
      <p className="text-helper text-fg-muted" data-testid="habit-week-strip-loading">
        {t("loading")}
      </p>
    );
  }
  const cells = weekCells(habit, week.data.habit);
  return (
    <ol
      aria-label={t("weekStripLabel", { habit: habit.name })}
      className="grid grid-cols-7 gap-1"
      data-testid="habit-week-strip"
    >
      {cells.map((cell) => {
        const date = texts.date(cell.date, "short");
        const stateText =
          cell.state === "partial" ? t("weekStripPartial") : texts.state(cell.state);
        const quantity =
          cell.numeric && cell.state !== "future"
            ? numericTexts.progress(
                cell.numeric.total,
                cell.numeric.target,
                cell.numeric.unit,
                cell.numeric.unitKind,
              )
            : null;
        const label = t("weekStripDay", {
          date,
          state: quantity ? `${stateText}, ${quantity}` : stateText,
        });
        const tone = cell.state === "partial" ? "text-fg" : stateTone[cell.state];
        return (
          <li
            key={cell.date}
            aria-label={label}
            aria-current={cell.date === habit.today ? "date" : undefined}
            className={cx(
              "relative flex min-h-11 flex-col items-center justify-center overflow-hidden rounded-control border border-line text-helper",
              cell.state === "future" ? "border-dashed" : "",
              tone,
            )}
            data-testid="habit-week-cell"
            data-state={cell.state}
          >
            {cell.fraction !== null && cell.fraction > 0 ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 bg-accent-subtle"
                style={{ height: `${String(Math.round(cell.fraction * 100))}%` }}
              />
            ) : null}
            <span aria-hidden="true" className="relative text-fg-muted">
              {formatWeekday(isoWeekday(cell.date), locale)}
            </span>
            <span aria-hidden="true" className="relative">
              {cell.state === "partial" ? "\u{25D0}" : stateMark[cell.state]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
