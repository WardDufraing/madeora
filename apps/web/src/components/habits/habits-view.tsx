"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import type { HabitView, HabitWeekStart } from "@madeora/domain/habits";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { EmptyState } from "@/components/ui/states";
import {
  HABIT_SETTINGS_ENDPOINT,
  HABITS_ENDPOINT,
  sendHabitRequest,
  type HabitList,
  type HabitSummary,
} from "@/habits/api";
import { habitKeys, habitsPath } from "@/habits/format";
import { memberNames, type MemberNames, type MemberOption } from "@/tasks/format";

import { HabitFormDialog } from "./habit-form-dialog";
import { HabitToday, HabitWeekProgress } from "./habit-today";
import { useHabitMutation } from "./use-habit-mutation";
import { useHabitTexts } from "./use-habit-texts";

/** Read again this often while the page is visible (no Realtime for habits). */
const REFRESH_INTERVAL_MS = 60_000;

export interface HabitsViewProps {
  readonly homeId: string | null;
  readonly view: HabitView;
  readonly query: string;
  readonly initialList: HabitList;
  readonly members: readonly MemberOption[];
  /** The context's today (the Home's timezone, or the viewer's). */
  readonly today: string;
  readonly weekStart: HabitWeekStart;
  readonly timeZone: string;
  readonly timeZones: readonly string[];
}

/** Reads the list again on focus, every minute and after each change. */
function useHabitList(homeId: string | null, view: HabitView, query: string, initial: HabitList) {
  const result = useQuery<{ list: HabitList }>({
    queryKey: [...habitKeys.all, "list", homeId ?? "personal", view, query],
    queryFn: () => {
      const search = new URLSearchParams({ view });
      if (homeId) search.set("homeId", homeId);
      if (query) search.set("q", query);
      return sendHabitRequest("GET", `${HABITS_ENDPOINT}?${search.toString()}`);
    },
    initialData: { list: initial },
    staleTime: 30_000,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  return result.data.list;
}

/**
 * The habits of one context (S28): active and paused ones with today's state, a weekly habit's
 * progress and the current streak, with Complete and Undo where allowed; or the Ended or Archived
 * habits, searchable by name. Habit managers create habits here; everyone sets their own
 * celebrations, and habit managers of a Home set whether members check in or only view.
 */
export function HabitsView({
  homeId,
  view,
  query,
  initialList,
  members,
  today,
  weekStart,
  timeZone,
  timeZones,
}: HabitsViewProps) {
  const t = useTranslations("Habits");
  const list = useHabitList(homeId, view, query, initialList);
  const names = memberNames(members);
  const [creating, setCreating] = useState(false);
  const base = habitsPath(homeId);
  const views = [
    { view: "active", label: t("viewActive", { count: list.counts.active }) },
    { view: "ended", label: t("viewEnded", { count: list.counts.ended }) },
    { view: "archived", label: t("viewArchived", { count: list.counts.archived }) },
  ] as const;
  return (
    <div className="flex flex-col gap-6" data-testid="habits-view">
      <nav aria-label={t("viewsLabel")}>
        <ul className="flex flex-wrap gap-2">
          {views.map((item) => (
            <li key={item.view}>
              <Link
                href={item.view === "active" ? base : `${base}?view=${item.view}`}
                aria-current={item.view === view ? "page" : undefined}
                className={
                  item.view === view
                    ? "inline-flex min-h-10 items-center rounded-control bg-accent-subtle px-3 text-body font-semibold text-fg"
                    : "inline-flex min-h-10 items-center rounded-control px-3 text-body text-accent-fg underline"
                }
                data-testid={`habits-view-${item.view}`}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {view !== "active" ? (
        <form method="get" action={base} role="search" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="view" value={view} />
          <label className="flex flex-col gap-1.5 text-body font-medium text-fg">
            {t("searchLabel")}
            <input
              type="search"
              name="q"
              defaultValue={query}
              maxLength={80}
              className="min-h-10 rounded-control border border-line-control bg-surface px-3 text-body text-fg"
              data-testid="habits-search"
            />
          </label>
          <Button type="submit" variant="secondary">
            {t("search")}
          </Button>
        </form>
      ) : null}
      {view === "active" && list.access === "manage" ? (
        <div>
          <Button
            onClick={() => {
              setCreating(true);
            }}
            data-testid="habit-new"
          >
            {t("newHabit")}
          </Button>
        </div>
      ) : null}
      {list.habits.length === 0 ? (
        <EmptyState
          title={
            query
              ? t("emptySearch")
              : view === "active"
                ? t("emptyActive")
                : view === "ended"
                  ? t("emptyEnded")
                  : t("emptyArchived")
          }
          description={
            view === "active" && !query
              ? list.access === "manage"
                ? t("emptyActiveManage")
                : t("emptyActiveView")
              : undefined
          }
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" data-testid="habit-list">
          {list.habits.map((habit) => (
            <li key={habit.id}>
              <HabitCard habit={habit} homeId={homeId} names={names} />
            </li>
          ))}
        </ul>
      )}
      <HabitSettings homeId={homeId} list={list} />
      {creating ? (
        <HabitFormDialog
          habit={null}
          homeId={homeId}
          today={today}
          weekStart={weekStart}
          timeZone={timeZone}
          timeZones={timeZones}
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}
    </div>
  );
}

function HabitCard({
  habit,
  homeId,
  names,
}: {
  readonly habit: HabitSummary;
  readonly homeId: string | null;
  readonly names: MemberNames;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const headingId = `habit-${habit.id}-name`;
  return (
    <article
      aria-labelledby={headingId}
      className="flex h-full flex-col gap-2 rounded-card border border-line bg-surface p-4"
      data-testid="habit-card"
    >
      <h2 id={headingId} className="text-section-title font-semibold text-fg">
        <Link href={habitsPath(homeId, habit.id)} className="underline-offset-4 hover:underline">
          <bdi>{habit.name}</bdi>
        </Link>
      </h2>
      <p className="text-helper text-fg-muted">
        {texts.schedule(habit.schedule)} · {texts.status(habit)}
      </p>
      {habit.status === "ended" && habit.endsOn ? (
        <p className="text-helper text-fg-muted">
          {t("endedOn", { date: texts.date(habit.endsOn, "short") })}
        </p>
      ) : null}
      {habit.status === "upcoming" ? (
        <p className="text-helper text-fg-muted">
          {t("startsOn", { date: texts.date(habit.periodStartsOn, "short") })}
        </p>
      ) : null}
      <HabitWeekProgress habit={habit} />
      <p className="text-body text-fg" data-testid="habit-streak">
        {texts.streak(habit.streak)}
      </p>
      {habit.status === "active" || habit.status === "paused" ? (
        <HabitToday habit={habit} names={names} source="app" />
      ) : null}
    </article>
  );
}

/** Celebrations (the viewer's own) and, for habit managers of a Home, the members' access. */
function HabitSettings({
  homeId,
  list,
}: {
  readonly homeId: string | null;
  readonly list: HabitList;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const celebrations = useHabitMutation("habit-celebrations", (enabled: boolean) =>
    sendHabitRequest("PATCH", HABIT_SETTINGS_ENDPOINT, { celebrations: enabled }),
  );
  const access = useHabitMutation("habit-member-access", (memberAccess: string) =>
    sendHabitRequest("PATCH", HABIT_SETTINGS_ENDPOINT, { homeId, memberAccess }),
  );
  const failure = celebrations.error ?? access.error;
  return (
    <section aria-labelledby="habit-settings-heading" className="flex max-w-xl flex-col gap-3">
      <h2 id="habit-settings-heading" className="text-section-title font-semibold">
        {t("settingsTitle")}
      </h2>
      <Checkbox
        label={t("celebrationsLabel")}
        description={t("celebrationsHint")}
        checked={list.celebrations}
        disabled={celebrations.busy}
        onChange={(event) => {
          celebrations.mutate(event.target.checked);
        }}
        data-testid="habit-celebrations"
      />
      {homeId && list.memberAccess ? (
        list.access === "manage" ? (
          <SelectField
            label={t("memberAccessLabel")}
            description={t("memberAccessHint")}
            value={list.memberAccess}
            disabled={access.busy}
            onChange={(event) => {
              access.mutate(event.target.value);
            }}
            options={[
              { value: "complete", label: t("memberAccessComplete") },
              { value: "view", label: t("memberAccessView") },
            ]}
            data-testid="habit-member-access"
          />
        ) : (
          <p className="text-body text-fg-muted">
            {list.memberAccess === "complete" ? t("membersComplete") : t("membersView")}
          </p>
        )
      ) : null}
      {failure ? (
        <FormAlert tone="error" announce>
          {texts.failure(failure.failure)}
        </FormAlert>
      ) : null}
    </section>
  );
}
