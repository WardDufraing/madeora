"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  habitEndpoint,
  sendHabitRequest,
  type HabitCalendar,
  type HabitCheckin,
  type HabitDay,
  type HabitDetail,
  type HabitInsights,
} from "@/habits/api";
import { habitKeys } from "@/habits/format";
import { memberNames, type MemberNames, type MemberOption } from "@/tasks/format";

import {
  ArchiveDialog,
  BackdateDialog,
  CorrectDialog,
  DeleteDialog,
  EndDateDialog,
  NoteDialog,
  PauseChangeDialog,
  PauseDialog,
  ReactivateDialog,
  RemindersDialog,
  ScheduleChangeDialog,
} from "./habit-dialogs";
import { HabitFormDialog } from "./habit-form-dialog";
import { HabitHistory } from "./habit-history";
import { HabitInsightsPanel } from "./habit-insights";
import { HabitToday, HabitWeekProgress } from "./habit-today";
import { useHabitCheckins } from "./use-habit-checkins";
import { useHabitMutation } from "./use-habit-mutation";
import { useHabitTexts } from "./use-habit-texts";

const REFRESH_INTERVAL_MS = 60_000;

type DialogKind =
  | "edit"
  | "schedule"
  | "end"
  | "pause"
  | "pauseChange"
  | "reminders"
  | "reactivate"
  | "archive"
  | "delete";

export interface HabitDetailViewProps {
  readonly initialHabit: HabitDetail;
  readonly initialInsights: HabitInsights | null;
  readonly initialCalendar: HabitCalendar | null;
  readonly days: number;
  readonly month: string;
  readonly members: readonly MemberOption[];
  /** Zones to offer when editing a personal habit. */
  readonly timeZones: readonly string[];
}

/** Reads the habit again on focus, every minute and after each change. */
function useHabitDetail(initial: HabitDetail): HabitDetail {
  const query = useQuery<{ habit: HabitDetail }>({
    queryKey: [...habitKeys.all, "detail", initial.id],
    queryFn: () => sendHabitRequest("GET", habitEndpoint(initial.id)),
    initialData: { habit: initial },
    staleTime: 30_000,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  return query.data.habit;
}

/**
 * One habit's page (S28): its status, today's check-in, streaks and milestones, the last eight days
 * (completing a missed day up to seven days back, Undo, notes, a manager's corrections), insights,
 * its schedule and tracking periods with their history, the change log, and the changes the viewer
 * may make. Every change is checked again by the database.
 */
export function HabitDetailView({
  initialHabit,
  initialInsights,
  initialCalendar,
  days,
  month,
  members,
  timeZones,
}: HabitDetailViewProps) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const habit = useHabitDetail(initialHabit);
  const names = memberNames(members);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const close = () => {
    setDialog(null);
  };
  const manage = habit.access === "manage";
  const ended = habit.status === "ended";
  const archived = habit.status === "archived";
  return (
    <div className="flex flex-col gap-8" data-testid="habit-detail">
      <div className="flex flex-col gap-2">
        <PageHeader title={habit.name} />
        <p className="text-body text-fg" data-testid="habit-status">
          {texts.status(habit)} · {texts.schedule(habit.schedule)}
        </p>
        {habit.description ? (
          <p className="max-w-prose whitespace-pre-line text-body text-fg-muted">
            <bdi>{habit.description}</bdi>
          </p>
        ) : null}
        <p className="text-helper text-fg-muted">
          {t("zoneAndWeek", { zone: habit.timeZone, weekStart: texts.weekStart(habit.weekStart) })}
        </p>
      </div>

      {habit.status === "active" || habit.status === "paused" ? (
        <section aria-labelledby="habit-today-heading" className="flex flex-col gap-2">
          <h2 id="habit-today-heading" className="text-section-title font-semibold">
            {t("todayTitle")}
          </h2>
          <HabitWeekProgress habit={habit} />
          <HabitToday habit={habit} names={names} source="app" />
        </section>
      ) : null}

      <section aria-labelledby="habit-streak-heading" className="flex flex-col gap-2">
        <h2 id="habit-streak-heading" className="text-section-title font-semibold">
          {t("streakTitle")}
        </h2>
        <p className="text-body text-fg" data-testid="habit-current-streak">
          {texts.streak(habit.streak)}
        </p>
        <p className="text-helper text-fg-muted">{texts.longest(habit.streak)}</p>
        {habit.milestones.length > 0 ? (
          <ul className="flex flex-col gap-1 text-body text-fg" data-testid="habit-milestones">
            {habit.milestones.map((milestone) => (
              <li key={`${milestone.unit}-${String(milestone.threshold)}-${milestone.reachedOn}`}>
                {milestone.unit === "weeks"
                  ? t("milestoneReachedWeeks", {
                      count: milestone.threshold,
                      date: texts.date(milestone.reachedOn, "short"),
                    })
                  : t("milestoneReachedOccurrences", {
                      count: milestone.threshold,
                      date: texts.date(milestone.reachedOn, "short"),
                    })}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-helper text-fg-muted">{t("noMilestones")}</p>
        )}
      </section>

      <RecentDays habit={habit} names={names} />

      <HabitInsightsPanel
        habitId={habit.id}
        weekStart={habit.weekStart}
        initialInsights={initialInsights}
        initialCalendar={initialCalendar}
        days={days}
        month={month}
      />

      <section aria-labelledby="habit-schedule-heading" className="flex flex-col gap-2">
        <h2 id="habit-schedule-heading" className="text-section-title font-semibold">
          {t("scheduleSection")}
        </h2>
        <ul className="flex flex-col gap-1 text-body text-fg" data-testid="habit-schedules">
          {habit.schedules.map((version) => (
            <li key={version.effectiveOn}>
              {t("scheduleFrom", {
                date: texts.date(version.effectiveOn, "short"),
                schedule: texts.schedule(version),
              })}
            </li>
          ))}
        </ul>
        <h3 className="text-body font-semibold text-fg">{t("periodsTitle")}</h3>
        <ul className="flex flex-col gap-1 text-body text-fg" data-testid="habit-periods">
          {habit.periods.map((period) => (
            <li key={period.id}>
              {t("periodRange", {
                from: texts.date(period.startsOn, "short"),
                to: period.endsOn ? texts.date(period.endsOn, "short") : t("periodOpen"),
              })}
            </li>
          ))}
        </ul>
        {habit.pauses.length > 0 ? (
          <>
            <h3 className="text-body font-semibold text-fg">{t("pausesTitle")}</h3>
            <ul className="flex flex-col gap-1 text-body text-fg">
              {habit.pauses.map((pause) => (
                <li key={pause.id}>
                  {pause.resumesOn
                    ? t("pauseUntil", {
                        from: texts.date(pause.startsOn, "short"),
                        to: texts.date(pause.resumesOn, "short"),
                      })
                    : t("pauseOpenFrom", { from: texts.date(pause.startsOn, "short") })}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="text-helper text-fg-muted">
          {habit.reminder?.enabled
            ? t("remindersSummary", {
                times: habit.reminder.times.join(", "),
                days: texts.weekdays(habit.reminder.weekdays),
              })
            : t("remindersOff")}
        </p>
      </section>

      {habit.homeId && habit.access !== "view" && habit.reminder?.enabled ? (
        <MyReminders habit={habit} />
      ) : null}

      {manage ? (
        <section aria-labelledby="habit-manage-heading" className="flex flex-col gap-3">
          <h2 id="habit-manage-heading" className="text-section-title font-semibold">
            {t("manageTitle")}
          </h2>
          <div className="flex flex-wrap gap-2">
            {!archived ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setDialog("edit");
                }}
                data-testid="habit-edit"
              >
                {t("edit")}
              </Button>
            ) : null}
            {!archived && !ended ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDialog("schedule");
                  }}
                  data-testid="habit-change-schedule"
                >
                  {t("changeSchedule")}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDialog("end");
                  }}
                  data-testid="habit-set-end"
                >
                  {habit.endsOn ? t("changeEnd") : t("setEnd")}
                </Button>
                {habit.pause ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setDialog("pauseChange");
                    }}
                    data-testid="habit-change-pause"
                  >
                    {t("changePause")}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setDialog("pause");
                    }}
                    data-testid="habit-pause"
                  >
                    {t("pause")}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDialog("reminders");
                  }}
                  data-testid="habit-reminders"
                >
                  {t("reminders")}
                </Button>
              </>
            ) : null}
            {ended ? (
              <Button
                onClick={() => {
                  setDialog("reactivate");
                }}
                data-testid="habit-reactivate"
              >
                {t("reactivate")}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                setDialog("archive");
              }}
              data-testid="habit-archive"
            >
              {archived ? t("unarchive") : t("archive")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDialog("delete");
              }}
              data-testid="habit-delete"
            >
              {t("delete")}
            </Button>
          </div>
        </section>
      ) : null}

      <HabitHistory habit={habit} names={names} />

      {dialog === "edit" ? (
        <HabitFormDialog
          habit={habit}
          homeId={habit.homeId}
          today={habit.today}
          weekStart={habit.weekStart}
          timeZone={habit.timeZone}
          timeZones={timeZones}
          onClose={close}
        />
      ) : null}
      {dialog === "schedule" ? <ScheduleChangeDialog habit={habit} onClose={close} /> : null}
      {dialog === "end" ? <EndDateDialog habit={habit} onClose={close} /> : null}
      {dialog === "pause" ? <PauseDialog habit={habit} onClose={close} /> : null}
      {dialog === "pauseChange" && habit.pause ? (
        <PauseChangeDialog habit={{ ...habit, pause: habit.pause }} onClose={close} />
      ) : null}
      {dialog === "reminders" ? <RemindersDialog habit={habit} onClose={close} /> : null}
      {dialog === "reactivate" ? <ReactivateDialog habit={habit} onClose={close} /> : null}
      {dialog === "archive" ? <ArchiveDialog habit={habit} onClose={close} /> : null}
      {dialog === "delete" ? <DeleteDialog habit={habit} onClose={close} /> : null}
    </div>
  );
}

/** The last eight days: their state, check-in, note, and what the viewer may do with each. */
function RecentDays({
  habit,
  names,
}: {
  readonly habit: HabitDetail;
  readonly names: MemberNames;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const checkins = useHabitCheckins(`habit:${habit.id}`);
  const [correcting, setCorrecting] = useState<HabitCheckin | null>(null);
  const [noting, setNoting] = useState<HabitCheckin | null>(null);
  const [backdating, setBackdating] = useState<HabitDay | null>(null);
  const may = habit.access !== "view";
  const complete = (onDate: string) => {
    checkins.complete.mutate({ habitId: habit.id, name: habit.name, onDate, source: "app" });
  };
  return (
    <section aria-labelledby="habit-recent-heading" className="flex flex-col gap-3">
      <h2 id="habit-recent-heading" className="text-section-title font-semibold">
        {t("recentTitle")}
      </h2>
      <p className="text-helper text-fg-muted">{t("recentExplanation")}</p>
      <ol className="flex flex-col gap-2" data-testid="habit-recent">
        {habit.recent.map((day) => {
          const checkin = day.checkin;
          const label = texts.date(day.onDate, "short");
          return (
            <li
              key={day.onDate}
              className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface p-3"
              data-testid="habit-day"
              data-state={day.state}
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-body font-medium text-fg">
                  {day.onDate === habit.today ? t("todayLabel", { date: label }) : label}
                </span>
                <span className="text-helper text-fg-muted">
                  {checkin
                    ? t("completedBy", { person: texts.who(checkin.by, checkin.mine, names) })
                    : texts.state(day.state)}
                  {checkin?.backdated ? ` · ${t("backdated")}` : ""}
                </span>
                {checkin?.note ? (
                  <span className="whitespace-pre-line text-helper text-fg">
                    <bdi>{checkin.note}</bdi>
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {may && !checkin && day.block === null ? (
                  <Button
                    size="sm"
                    loading={
                      checkins.complete.busy && checkins.complete.variables?.onDate === day.onDate
                    }
                    aria-label={t("markCompletedOn", { habit: habit.name, date: label })}
                    onClick={() => {
                      checkins.reset();
                      if (day.onDate === habit.today) complete(day.onDate);
                      else setBackdating(day);
                    }}
                    data-testid="habit-day-complete"
                  >
                    {t("markCompleted")}
                  </Button>
                ) : null}
                {checkin?.action === "undo" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={
                      checkins.undo.busy && checkins.undo.variables?.checkin.id === checkin.id
                    }
                    aria-label={t("undoOn", { habit: habit.name, date: label })}
                    onClick={() => {
                      checkins.reset();
                      checkins.undo.mutate({ checkin, name: habit.name });
                    }}
                    data-testid="habit-day-undo"
                  >
                    {t("undo")}
                  </Button>
                ) : null}
                {checkin?.action === "correct" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={t("correctOn", { date: label })}
                    onClick={() => {
                      setCorrecting(checkin);
                    }}
                    data-testid="habit-day-correct"
                  >
                    {t("correct")}
                  </Button>
                ) : null}
                {checkin?.mine && checkin.status === "active" && may ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={
                      checkin.note
                        ? t("editNoteOn", { date: label })
                        : t("addNoteOn", { date: label })
                    }
                    onClick={() => {
                      setNoting(checkin);
                    }}
                    data-testid="habit-day-note"
                  >
                    {checkin.note ? t("editNote") : t("addNote")}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {checkins.failureText ? (
        <FormAlert tone="error" announce>
          {checkins.failureText}
        </FormAlert>
      ) : null}
      {correcting ? (
        <CorrectDialog
          checkin={correcting}
          habitName={habit.name}
          onClose={() => {
            setCorrecting(null);
          }}
        />
      ) : null}
      {backdating ? (
        <BackdateDialog
          habitName={habit.name}
          day={backdating}
          today={habit.today}
          busy={checkins.complete.busy}
          onConfirm={() => {
            complete(backdating.onDate);
            setBackdating(null);
          }}
          onClose={() => {
            setBackdating(null);
          }}
        />
      ) : null}
      {noting ? (
        <NoteDialog
          checkin={noting}
          onClose={() => {
            setNoting(null);
          }}
        />
      ) : null}
    </section>
  );
}

/** A Home habit's reminders for the viewer only: on unless they turned them off. */
function MyReminders({ habit }: { readonly habit: HabitDetail }) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const save = useHabitMutation(`habit-my-reminders:${habit.id}`, (enabled: boolean) =>
    sendHabitRequest("PUT", habitEndpoint(habit.id, "my-reminders"), { enabled }),
  );
  return (
    <section aria-labelledby="habit-my-reminders-heading" className="flex max-w-xl flex-col gap-2">
      <h2 id="habit-my-reminders-heading" className="text-section-title font-semibold">
        {t("myRemindersTitle")}
      </h2>
      <Checkbox
        label={t("myRemindersLabel")}
        description={t("myRemindersHint")}
        checked={habit.myReminders}
        disabled={save.busy}
        onChange={(event) => {
          save.mutate(event.target.checked);
        }}
        data-testid="habit-my-reminders"
      />
      {save.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(save.error.failure)}
        </FormAlert>
      ) : null}
    </section>
  );
}
