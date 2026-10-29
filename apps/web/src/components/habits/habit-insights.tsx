"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import {
  addDays,
  habitInsightDays,
  habitMonthGrid,
  habitWeekdayOrder,
  type HabitDayState,
  type HabitWeekStart,
} from "@madeora/domain/habits";

import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/states";
import {
  habitEndpoint,
  sendHabitRequest,
  type HabitCalendar,
  type HabitInsights,
} from "@/habits/api";
import { completionRate, formatWeekday, habitKeys } from "@/habits/format";

import { NumericSummaries } from "./habit-numeric-summaries";
import { useHabitTexts } from "./use-habit-texts";

/** A mark per state, so a state never depends on colour alone. */
const stateMark: { readonly [S in HabitDayState]: string } = {
  completed: "\u{2713}",
  missed: "\u{2717}",
  paused: "\u{2016}",
  pending: "\u{25CB}",
  open: "\u{25CB}",
  not_scheduled: "\u{2013}",
  untracked: "\u{00B7}",
  future: "",
};

const stateTone: { readonly [S in HabitDayState]: string } = {
  completed: "bg-accent-subtle text-fg font-semibold",
  missed: "text-danger",
  paused: "text-fg-muted",
  pending: "text-fg",
  open: "text-fg",
  not_scheduled: "text-fg-muted",
  untracked: "text-fg-muted",
  future: "text-fg-muted",
};

export interface HabitInsightsProps {
  readonly habitId: string;
  readonly weekStart: HabitWeekStart;
  readonly initialInsights: HabitInsights | null;
  readonly initialCalendar: HabitCalendar | null;
  readonly days: number;
  readonly month: string;
}

/**
 * A habit's insights (S28): the completion rate over the last 7, 30, 90 or 365 days (eligible
 * opportunities only, or "no eligible opportunities"), streaks, paused days and schedule changes in
 * the range, a 12-week trend with every value as text, and a month calendar whose every state has
 * a mark and a name, with the same days as a text list.
 */
export function HabitInsightsPanel({
  habitId,
  weekStart,
  initialInsights,
  initialCalendar,
  days: initialDays,
  month: initialMonth,
}: HabitInsightsProps) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const [days, setDays] = useState(initialDays);
  const [month, setMonth] = useState(initialMonth);
  const insights = useQuery<{ insights: HabitInsights }>({
    queryKey: habitKeys.insights(habitId, days),
    queryFn: () =>
      sendHabitRequest("GET", `${habitEndpoint(habitId, "insights")}?days=${String(days)}`),
    ...(initialInsights && days === initialDays
      ? { initialData: { insights: initialInsights } }
      : {}),
    staleTime: 30_000,
  });
  const calendar = useQuery<{ calendar: HabitCalendar }>({
    queryKey: habitKeys.calendar(habitId, month),
    queryFn: () => sendHabitRequest("GET", `${habitEndpoint(habitId, "calendar")}?month=${month}`),
    ...(initialCalendar && month === initialMonth
      ? { initialData: { calendar: initialCalendar } }
      : {}),
    staleTime: 30_000,
  });
  const value = insights.data?.insights;
  return (
    <section aria-labelledby="habit-insights-heading" className="flex flex-col gap-4">
      <h2 id="habit-insights-heading" className="text-section-title font-semibold">
        {t("insightsTitle")}
      </h2>
      <div role="group" aria-label={t("insightsPeriod")} className="flex flex-wrap gap-2">
        {habitInsightDays.map((option) => (
          <Button
            key={option}
            size="sm"
            variant={option === days ? "primary" : "secondary"}
            aria-pressed={option === days}
            onClick={() => {
              setDays(option);
            }}
            data-testid={`habit-insights-${String(option)}`}
          >
            {t("insightsDays", { count: option })}
          </Button>
        ))}
      </div>
      {insights.isError ? (
        <p className="text-body text-danger">{t("insightsFailed")}</p>
      ) : !value ? (
        <LoadingState label={t("loading")} />
      ) : (
        <InsightsSummary insights={value} />
      )}
      {value?.numeric ? <NumericSummaries summary={value.numeric} /> : null}
      {value ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-body font-semibold text-fg">{t("trendTitle")}</h3>
          <div className="flex h-24 items-end gap-1" aria-hidden="true">
            {value.trend.map((week) => {
              const rate = completionRate(week.completed, week.eligible);
              return (
                <div
                  key={week.weekOn}
                  className="flex h-full flex-1 items-end rounded-sm bg-surface-sunken"
                  title={texts.date(week.weekOn, "short")}
                >
                  <div
                    className="w-full rounded-sm bg-accent"
                    style={{ height: `${String(rate ?? 0)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <ol
            className="grid gap-x-4 text-helper text-fg-muted sm:grid-cols-2"
            data-testid="habit-trend"
          >
            {value.trend.map((week) => {
              const rate = completionRate(week.completed, week.eligible);
              return (
                <li key={week.weekOn}>
                  {rate === null
                    ? t("trendWeekNone", { week: texts.date(week.weekOn, "short") })
                    : t("trendWeek", {
                        week: texts.date(week.weekOn, "short"),
                        done: week.completed,
                        eligible: week.eligible,
                        rate,
                      })}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
      <MonthCalendar
        calendar={calendar.data?.calendar ?? null}
        failed={calendar.isError}
        month={month}
        weekStart={weekStart}
        onMonth={setMonth}
      />
    </section>
  );
}

function InsightsSummary({ insights }: { readonly insights: HabitInsights }) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const rate = completionRate(insights.completed, insights.eligible);
  return (
    <dl className="grid gap-3 sm:grid-cols-2" data-testid="habit-insights-summary">
      <div className="rounded-card border border-line bg-surface p-3">
        <dt className="text-helper text-fg-muted">{t("insightsRate")}</dt>
        <dd className="text-section-title font-semibold text-fg" data-testid="habit-insights-rate">
          {rate === null ? t("insightsNoEligible") : t("insightsRateValue", { rate })}
        </dd>
        {rate !== null ? (
          <dd className="text-helper text-fg-muted">
            {t("insightsRateDetail", { done: insights.completed, eligible: insights.eligible })}
          </dd>
        ) : null}
      </div>
      <div className="rounded-card border border-line bg-surface p-3">
        <dt className="text-helper text-fg-muted">{t("insightsStreaks")}</dt>
        <dd className="text-body text-fg">{texts.streak(insights.streak)}</dd>
        <dd className="text-helper text-fg-muted">{texts.longest(insights.streak)}</dd>
      </div>
      {insights.pausedDays > 0 ? (
        <div className="rounded-card border border-line bg-surface p-3">
          <dt className="text-helper text-fg-muted">{t("insightsPaused")}</dt>
          <dd className="text-body text-fg">
            {t("insightsPausedDays", { count: insights.pausedDays })}
          </dd>
        </div>
      ) : null}
      {insights.scheduleChanges.length > 0 ? (
        <div className="rounded-card border border-line bg-surface p-3">
          <dt className="text-helper text-fg-muted">{t("insightsScheduleChanges")}</dt>
          {insights.scheduleChanges.map((change) => (
            <dd key={change.effectiveOn} className="text-body text-fg">
              {t("scheduleFrom", {
                date: texts.date(change.effectiveOn, "short"),
                schedule: texts.schedule(change),
              })}
            </dd>
          ))}
        </div>
      ) : null}
      {insights.periods.length > 1 ? (
        <div className="rounded-card border border-line bg-surface p-3 sm:col-span-2">
          <dt className="text-helper text-fg-muted">{t("insightsPeriods")}</dt>
          {insights.periods.map((period) => {
            const periodRate = completionRate(period.completed, period.eligible);
            return (
              <dd key={period.startsOn} className="text-body text-fg">
                {t("periodLine", {
                  from: texts.date(period.startsOn, "short"),
                  to: period.endsOn ? texts.date(period.endsOn, "short") : t("periodOpen"),
                  rate:
                    periodRate === null
                      ? t("insightsNoEligible")
                      : t("insightsRateValue", { rate: periodRate }),
                })}
              </dd>
            );
          })}
        </div>
      ) : null}
    </dl>
  );
}

function MonthCalendar({
  calendar,
  failed,
  month,
  weekStart,
  onMonth,
}: {
  readonly calendar: HabitCalendar | null;
  readonly failed: boolean;
  readonly month: string;
  readonly weekStart: HabitWeekStart;
  readonly onMonth: (month: string) => void;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const locale = useLocale();
  const first = `${month}-01`;
  const previous = addDays(first, -1).slice(0, 7);
  const next = addDays(first, 31).slice(0, 7);
  const states = new Map(calendar?.days.map((day) => [day.onDate, day]) ?? []);
  const label = texts.date(first, "month");
  return (
    <div className="flex flex-col gap-3" data-testid="habit-calendar">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-body font-semibold text-fg" aria-live="polite">
          {label}
        </h3>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onMonth(previous);
          }}
          aria-label={t("previousMonth")}
        >
          {"\u{2039}"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onMonth(next);
          }}
          aria-label={t("nextMonth")}
        >
          {"\u{203A}"}
        </Button>
      </div>
      {failed ? <p className="text-body text-danger">{t("calendarFailed")}</p> : null}
      {calendar ? (
        <>
          <table className="w-full max-w-md table-fixed border-collapse text-center">
            <caption className="sr-only">{t("calendarCaption", { month: label })}</caption>
            <thead>
              <tr>
                {habitWeekdayOrder(weekStart).map((day) => (
                  <th key={day} scope="col" className="p-1 text-helper font-medium text-fg-muted">
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
                    const day = date ? states.get(date) : undefined;
                    return (
                      <td key={date ?? `empty-${String(column)}`} className="p-0.5">
                        {date && day ? (
                          <span
                            className={`flex min-h-10 flex-col items-center justify-center rounded-control text-helper ${stateTone[day.state]}`}
                            aria-current={date === calendar.today ? "date" : undefined}
                          >
                            <span>{Number(date.slice(8))}</span>
                            <span aria-hidden="true">{stateMark[day.state]}</span>
                            <span className="sr-only">{texts.state(day.state)}</span>
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
            {t("calendarLegend", {
              done: stateMark.completed,
              missed: stateMark.missed,
              paused: stateMark.paused,
              open: stateMark.pending,
              none: stateMark.not_scheduled,
            })}
          </p>
          <details>
            <summary className="cursor-pointer text-body text-accent-fg underline">
              {t("calendarAsList")}
            </summary>
            <ul className="mt-2 flex flex-col gap-1 text-body text-fg">
              {calendar.days
                .filter((day) => day.state !== "future" && day.state !== "untracked")
                .map((day) => (
                  <li key={day.onDate}>
                    {t("calendarDay", {
                      date: texts.date(day.onDate, "short"),
                      state: texts.state(day.state),
                    })}
                  </li>
                ))}
            </ul>
            {calendar.weeks.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1 text-body text-fg">
                {calendar.weeks.map((week) => (
                  <li key={`${week.weekOn}-${week.firstOn}`}>
                    {t("calendarWeek", {
                      week: texts.date(week.firstOn, "short"),
                      done: week.completions,
                      target: week.adjusted,
                    })}
                  </li>
                ))}
              </ul>
            ) : null}
          </details>
        </>
      ) : failed ? null : (
        <LoadingState label={t("loading")} />
      )}
    </div>
  );
}
