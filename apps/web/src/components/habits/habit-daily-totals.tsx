"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  habitEndpoint,
  sendHabitRequest,
  type HabitDailyTotals,
  type HabitDetail,
  type HabitNumericDay,
  type HabitTracking,
} from "@/habits/api";
import { habitKeys } from "@/habits/format";
import type { MemberNames } from "@/tasks/format";

import { AddProgressDialog, ContributionsDialog, DayNoteDialog } from "./habit-numeric-dialogs";
import { useHabitTexts } from "./use-habit-texts";
import { useNumericTexts } from "./use-numeric-texts";

type DayDialog = "add" | "note" | "review";

/**
 * One numeric day as a row: the exact total against that day's own target and unit, its state and
 * its note, and what the viewer may do: add progress while the day is open for it, edit the note
 * (habit managers), review contributions (their own, or everyone's for managers). Aggregates only:
 * the row never says who added what.
 */
export function NumericDayRow({
  habit,
  day,
  names,
}: {
  readonly habit: HabitDetail;
  readonly day: HabitNumericDay;
  readonly names: MemberNames;
}) {
  const t = useTranslations("HabitsNumeric");
  const texts = useHabitTexts();
  const numeric = useNumericTexts();
  const [dialog, setDialog] = useState<DayDialog | null>(null);
  const close = () => {
    setDialog(null);
  };
  const label = texts.date(day.onDate, "short");
  const may = habit.access !== "view";
  const manage = habit.access === "manage";
  const total = numeric.progress(day.total, day.target, day.unit, day.unitKind);
  return (
    <li
      className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3"
      data-testid="habit-numeric-day"
      data-state={day.state}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-body font-medium text-fg">
            {day.onDate === habit.today ? t("todayLabel", { date: label }) : label}
          </span>
          <span className="text-body text-fg" data-testid="habit-numeric-day-total">
            {total}
          </span>
          <span className="text-helper text-fg-muted">
            {day.met
              ? day.above
                ? t("dayAbove")
                : t("dayMet")
              : day.state === "completed"
                ? t("dayMet")
                : texts.state(day.state)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {may && day.block === null ? (
            <Button
              size="sm"
              aria-label={t("addToDayLabel", { habit: habit.name, date: label })}
              onClick={() => {
                setDialog("add");
              }}
              data-testid="habit-day-add-progress"
            >
              {t("addProgress")}
            </Button>
          ) : null}
          {may ? (
            <Button
              size="sm"
              variant="secondary"
              aria-label={t("reviewLabel", { date: label })}
              onClick={() => {
                setDialog("review");
              }}
              data-testid="habit-day-review"
            >
              {manage ? t("reviewContributions") : t("reviewMine")}
            </Button>
          ) : null}
          {manage && day.state !== "future" ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label={
                day.note ? t("editDayNoteOn", { date: label }) : t("addDayNoteOn", { date: label })
              }
              onClick={() => {
                setDialog("note");
              }}
              data-testid="habit-day-note-edit"
            >
              {day.note ? t("editNote") : t("addNote")}
            </Button>
          ) : null}
        </div>
      </div>
      {day.note ? (
        <p className="whitespace-pre-line text-helper text-fg" data-testid="habit-numeric-day-note">
          <bdi>{day.note}</bdi>
        </p>
      ) : null}
      {dialog === "add" ? <AddProgressDialog habit={habit} day={day} onClose={close} /> : null}
      {dialog === "note" ? <DayNoteDialog habit={habit} day={day} onClose={close} /> : null}
      {dialog === "review" ? (
        <ContributionsDialog habit={habit} day={day} names={names} onClose={close} />
      ) : null}
    </li>
  );
}

/** Older daily totals, a month at a time, after the last eight days the page already shows. */
export function OlderDailyTotals({
  habit,
  names,
  oldest,
}: {
  readonly habit: HabitDetail;
  readonly names: MemberNames;
  /** The oldest day already shown: older days continue from there. */
  readonly oldest: string | null;
}) {
  const t = useTranslations("HabitsNumeric");
  const query = useInfiniteQuery({
    queryKey: [...habitKeys.all, "days", habit.id, oldest],
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const before = pageParam ?? oldest;
      const search = before ? `?before=${encodeURIComponent(before)}` : "";
      const answer = await sendHabitRequest<{ totals: HabitDailyTotals }>(
        "GET",
        `${habitEndpoint(habit.id, "days")}${search}`,
      );
      return answer.totals;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last: HabitDailyTotals) =>
      last.hasMore ? (last.days.at(-1)?.onDate ?? undefined) : undefined,
    enabled: false,
  });
  const days = query.data?.pages.flatMap((page) => page.days) ?? [];
  return (
    <div className="flex flex-col gap-2">
      {days.length > 0 ? (
        <ol className="flex flex-col gap-2" data-testid="habit-older-days">
          {days.map((day) => (
            <NumericDayRow key={day.onDate} habit={habit} day={day} names={names} />
          ))}
        </ol>
      ) : null}
      {query.isError ? <p className="text-body text-danger">{t("olderFailed")}</p> : null}
      {query.data === undefined || query.hasNextPage ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            loading={query.isFetching}
            onClick={() => {
              void (query.data === undefined ? query.refetch() : query.fetchNextPage());
            }}
            data-testid="habit-older-days-more"
          >
            {t("showOlderDays")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The versions of how the habit is tracked, with what starts later. */
export function TrackingHistory({ habit }: { readonly habit: HabitDetail }) {
  const t = useTranslations("HabitsNumeric");
  const texts = useHabitTexts();
  const numeric = useNumericTexts();
  const describe = (tracking: HabitTracking) =>
    tracking.mode === "numeric" && tracking.target !== null && tracking.unit !== null
      ? t("trackingDaily", {
          amount: numeric.amount(tracking.target, tracking.unit, tracking.unitKind ?? "preset"),
        })
      : t("trackingOnce");
  if (habit.trackings.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-body font-semibold text-fg">{t("trackingHistoryTitle")}</h3>
      <ul className="flex flex-col gap-1 text-body text-fg" data-testid="habit-trackings">
        {habit.trackings.map((tracking) => (
          <li key={tracking.effectiveOn ?? "start"}>
            {tracking.effectiveOn
              ? t("trackingFrom", {
                  date: texts.date(tracking.effectiveOn, "short"),
                  tracking: describe(tracking),
                })
              : describe(tracking)}
          </li>
        ))}
      </ul>
    </div>
  );
}
