"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";

import {
  HABITS_ENDPOINT,
  sendHabitRequest,
  type HabitInsights,
  type HabitList,
} from "@/habits/api";
import { completionRate, habitKeys, habitsPath } from "@/habits/format";
import { memberNames, type MemberOption } from "@/tasks/format";

import { HabitToday, HabitWeekProgress } from "./habit-today";
import { useHabitTexts } from "./use-habit-texts";

const REFRESH_INTERVAL_MS = 60_000;

/** Today's habits, read again on focus, every minute and after each change. */
export function HabitsWidgetBody({
  homeId,
  initialList,
  count,
  members,
}: {
  readonly homeId: string | null;
  readonly initialList: HabitList;
  readonly count: number;
  readonly members: readonly MemberOption[];
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const query = useQuery<{ list: HabitList }>({
    queryKey: [...habitKeys.all, "list", homeId ?? "personal", "active", ""],
    queryFn: () =>
      sendHabitRequest(
        "GET",
        homeId ? `${HABITS_ENDPOINT}?homeId=${encodeURIComponent(homeId)}` : HABITS_ENDPOINT,
      ),
    initialData: { list: initialList },
    staleTime: 30_000,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  const names = memberNames(members);
  const habits = query.data.list.habits.filter(
    (habit) => habit.status === "active" || habit.status === "paused",
  );
  const shown = habits.slice(0, count);
  return (
    <div className="flex flex-col gap-3" data-testid="habits-widget">
      {shown.length === 0 ? (
        <p className="text-body text-fg-muted">{t("widgetNoHabits")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((habit) => (
            <li
              key={habit.id}
              className="flex flex-col gap-1 border-b border-line pb-3 last:border-0"
            >
              <Link
                href={habitsPath(homeId, habit.id)}
                className="text-body font-medium text-fg underline-offset-4 hover:underline"
              >
                <bdi>{habit.name}</bdi>
              </Link>
              <p className="text-helper text-fg-muted">
                {texts.streak(habit.streak)}
                {habit.status === "paused" ? ` · ${texts.status(habit)}` : ""}
              </p>
              <HabitWeekProgress habit={habit} />
              <HabitToday habit={habit} names={names} source="widget" compact />
            </li>
          ))}
        </ul>
      )}
      <Link href={habitsPath(homeId)} className="text-body font-medium text-accent-fg underline">
        {habits.length > shown.length
          ? t("widgetMore", { count: habits.length - shown.length })
          : t("widgetOpenHabits")}
      </Link>
    </div>
  );
}

/** One habit's last 30 days: rate, streak and a 12-week mini trend with its values as text. */
export function HabitInsightsWidgetBody({ insights }: { readonly insights: HabitInsights }) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const habit = insights.habit;
  const rate = completionRate(insights.completed, insights.eligible);
  const trend = insights.trend.map((week) => completionRate(week.completed, week.eligible));
  return (
    <div className="flex flex-col gap-2" data-testid="habit-insights-widget">
      <p className="text-body font-medium text-fg">
        <bdi>{habit.name}</bdi>
        {habit.status === "ended" ? ` · ${t("statusEnded")}` : ""}
        {habit.status === "archived" ? ` · ${t("statusArchived")}` : ""}
      </p>
      <p className="text-section-title font-semibold text-fg">
        {rate === null ? t("insightsNoEligible") : t("widgetRate30", { rate })}
      </p>
      <p className="text-body text-fg">{texts.streak(insights.streak)}</p>
      <div className="flex h-10 items-end gap-0.5" aria-hidden="true">
        {trend.map((value, index) => (
          <div key={index} className="flex h-full flex-1 items-end rounded-sm bg-surface-sunken">
            <div
              className="w-full rounded-sm bg-accent"
              style={{ height: `${String(value ?? 0)}%` }}
            />
          </div>
        ))}
      </div>
      <p className="text-helper text-fg-muted">
        {t("widgetTrendText", {
          values: trend.map((value) => (value === null ? "–" : `${String(value)}%`)).join(", "),
        })}
      </p>
      <Link
        href={habitsPath(habit.homeId, habit.id)}
        className="text-body font-medium text-accent-fg underline"
      >
        {t("viewInsights")}
      </Link>
    </div>
  );
}
