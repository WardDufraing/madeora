"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import {
  earliestHabitChange,
  HABIT_LIMITS,
  habitWeekdayOrder,
  type HabitScheduleKind,
} from "@madeora/domain/habits";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useToast } from "@/components/ui/toast";
import {
  habitCheckinEndpoint,
  habitEndpoint,
  habitPauseEndpoint,
  HabitRequestError,
  sendHabitRequest,
  type HabitCheckin,
  type HabitDay,
  type HabitDetail,
  type HabitSummary,
} from "@/habits/api";
import { formatWeekday, habitsPath } from "@/habits/format";
import { habitNoteSchema, habitReasonSchema } from "@/habits/schema";

import { HabitScheduleFields, scheduleBody, type ScheduleDraft } from "./habit-schedule-fields";
import { useHabitCheckins } from "./use-habit-checkins";
import { useHabitMutation } from "./use-habit-mutation";
import { useHabitTexts } from "./use-habit-texts";

// What previews answer (supabase/migrations/*_habits.sql); anything else shows no details.
const date = z.iso.date();
const nextDates = z
  .array(z.object({ onDate: date, paused: z.boolean() }))
  .nullable()
  .optional();
const ranges = z.array(z.object({ startsOn: date, endsOn: date })).optional();
const pauses = z.array(z.object({ startsOn: date, resumesOn: date.nullable() })).optional();
const scheduleImpact = z.object({
  earliest: date,
  weekBoundary: z.boolean(),
  nextDates,
  currentStreak: z.object({ current: z.int(), unit: z.enum(["occurrences", "weeks"]).nullable() }),
  unitChanges: z.boolean(),
  pauses,
  vacationDays: ranges,
  reminder: z.object({ enabled: z.boolean(), meetsSchedule: z.boolean() }).nullable().optional(),
});
const endImpact = z.object({
  endsOn: date.nullable(),
  previousEndsOn: date.nullable(),
  inPast: z.boolean(),
  checkinsAfter: z.int(),
  lastScheduled: date.nullable().optional(),
});
const reactivateImpact = z.object({
  startsOn: date,
  endsOn: date.nullable(),
  previousReminder: z
    .object({
      enabled: z.boolean(),
      times: z.array(z.string()).nullable(),
      weekdays: z.array(z.int()).nullable(),
      fitsSchedule: z.boolean(),
    })
    .nullable()
    .optional(),
  pauses,
  nextDates,
  longest: z.object({ occurrences: z.int(), weeks: z.int() }),
});
const pauseImpact = z.object({
  startsOn: date,
  resumesOn: date.nullable(),
  scheduledDays: z.int(),
  todayDone: z.boolean(),
  vacationDays: ranges,
  reminders: z.boolean(),
});
const pauseChangeImpact = z.object({
  startsOn: date,
  resumesOn: date.nullable(),
  previousResumesOn: date.nullable(),
  vacationToday: z.boolean(),
});

interface PreviewAnswer {
  readonly impact: unknown;
}

/**
 * The preview-then-confirm flow shared by the habit's change dialogs: the same request with
 * `preview: true` answers what would change without changing anything; confirming sends it again
 * without. A refusal that carries an impact (dates not allowed, check-ins after an end) shows it.
 */
function usePreviewFlow<Body extends object>(
  scope: string,
  method: string,
  url: string,
  onDone: () => void,
) {
  const [impact, setImpact] = useState<unknown>(null);
  const preview = useHabitMutation(
    `${scope}:preview`,
    (body: Body) => sendHabitRequest<PreviewAnswer>(method, url, { ...body, preview: true }),
    (answer) => {
      setImpact(answer.impact);
    },
  );
  const confirm = useHabitMutation(
    scope,
    (body: Body) => sendHabitRequest<PreviewAnswer>(method, url, { ...body, preview: false }),
    onDone,
  );
  const error = confirm.error ?? preview.error;
  const refusedImpact =
    error instanceof HabitRequestError && error.details.impact ? error.details.impact : null;
  return {
    impact: refusedImpact ?? impact,
    previewed: impact !== null,
    preview,
    confirm,
    error,
    clear: () => {
      setImpact(null);
      preview.reset();
      confirm.reset();
    },
  };
}

function DialogActions({
  onClose,
  children,
}: {
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const t = useTranslations("Habits");
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="secondary" onClick={onClose}>
        {t("cancel")}
      </Button>
      {children}
    </div>
  );
}

function Failure({ error }: { readonly error: HabitRequestError | null }) {
  const texts = useHabitTexts();
  return error ? (
    <FormAlert tone="error" announce>
      {texts.failure(error.failure)}
    </FormAlert>
  ) : null;
}

function DateList({ dates }: { readonly dates: readonly { onDate: string; paused: boolean }[] }) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  if (dates.length === 0) return null;
  return (
    <div>
      <p className="text-body font-medium text-fg">{t("previewNextDates")}</p>
      <ul className="list-disc ps-5 text-body text-fg">
        {dates.map((day) => (
          <li key={day.onDate}>
            {texts.date(day.onDate, "short")}
            {day.paused ? ` · ${t("statePaused")}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RangeList({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly {
    startsOn: string;
    endsOn?: string | null;
    resumesOn?: string | null;
  }[];
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-body font-medium text-fg">{label}</p>
      <ul className="list-disc ps-5 text-body text-fg">
        {items.map((item) => (
          <li key={item.startsOn}>
            {item.endsOn !== undefined
              ? t("rangeDates", {
                  from: texts.date(item.startsOn, "short"),
                  to: texts.date(item.endsOn ?? item.startsOn, "short"),
                })
              : item.resumesOn
                ? t("pauseUntil", {
                    from: texts.date(item.startsOn, "short"),
                    to: texts.date(item.resumesOn, "short"),
                  })
                : t("pauseOpenFrom", { from: texts.date(item.startsOn, "short") })}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Preview({ children }: { readonly children: ReactNode }) {
  const t = useTranslations("Habits");
  return (
    <section
      aria-label={t("previewTitle")}
      className="flex flex-col gap-2 rounded-card border border-line bg-surface-sunken p-3"
      data-testid="habit-preview"
    >
      {children}
    </section>
  );
}

/** A forward-only schedule change: from tomorrow, or a later week start when weekly is involved. */
export function ScheduleChangeDialog({
  habit,
  onClose,
}: {
  readonly habit: HabitDetail;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const current = habit.nextSchedule ?? habit.schedule;
  const [draft, setDraft] = useState<ScheduleDraft>({
    kind: current?.kind ?? "daily",
    weekdays: current?.weekdays ?? [],
    target: current?.target ?? 3,
  });
  const earliest = (kind: HabitScheduleKind) =>
    earliestHabitChange(habit.today, habit.weekStart, habit.schedule?.kind ?? "daily", kind);
  const [effectiveOn, setEffectiveOn] = useState(earliest(draft.kind));
  const flow = usePreviewFlow(
    `habit:${habit.id}`,
    "POST",
    habitEndpoint(habit.id, "schedule"),
    onClose,
  );
  const body = {
    revision: habit.revision,
    schedule: scheduleBody(draft),
    effectiveOn,
  };
  const impact = scheduleImpact.safeParse(flow.impact);
  const weekdaysMissing = draft.kind === "weekdays" && draft.weekdays.length === 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("scheduleTitle")}
      description={t("scheduleExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (weekdaysMissing) return;
          if (flow.previewed) flow.confirm.mutate(body);
          else flow.preview.mutate(body);
        }}
      >
        <p className="text-body text-fg">
          {t("scheduleCurrent", { schedule: texts.schedule(habit.schedule) })}
        </p>
        <HabitScheduleFields
          value={draft}
          onChange={(next) => {
            flow.clear();
            if (next.kind !== draft.kind) setEffectiveOn(earliest(next.kind));
            setDraft(next);
          }}
          weekStart={habit.weekStart}
          error={weekdaysMissing ? texts.field("weekdaysRequired") : undefined}
        />
        <TextField
          label={t("fieldEffectiveOn")}
          description={
            draft.kind === "weekly" || habit.schedule?.kind === "weekly"
              ? t("fieldEffectiveOnWeekHint")
              : t("fieldEffectiveOnHint")
          }
          type="date"
          min={earliest(draft.kind)}
          value={effectiveOn}
          onChange={(event) => {
            flow.clear();
            setEffectiveOn(event.target.value);
          }}
          data-testid="habit-effective-on"
        />
        {impact.success ? (
          <Preview>
            <p className="text-body text-fg">
              {t("previewScheduleChange", {
                from: texts.schedule(habit.schedule),
                to: texts.schedule(scheduleBody(draft)),
                date: texts.date(effectiveOn, "short"),
              })}
            </p>
            {flow.error?.failure === "invalidDates" ? (
              <p className="text-body text-danger">
                {t("previewEarliest", { date: texts.date(impact.data.earliest, "short") })}
              </p>
            ) : null}
            <p className="text-body text-fg">
              {t("previewStreakKept", { streak: texts.streak(impact.data.currentStreak) })}
            </p>
            {impact.data.unitChanges ? (
              <p className="text-body text-fg">{t("previewUnitChanges")}</p>
            ) : null}
            <DateList dates={impact.data.nextDates ?? []} />
            <RangeList label={t("previewPauses")} items={impact.data.pauses ?? []} />
            <RangeList label={t("previewVacationDays")} items={impact.data.vacationDays ?? []} />
            {impact.data.reminder ? (
              <p className="text-body text-fg">
                {impact.data.reminder.meetsSchedule
                  ? t("previewReminderKept")
                  : t("previewReminderNoDays")}
              </p>
            ) : null}
          </Preview>
        ) : null}
        <Failure error={flow.error} />
        <DialogActions onClose={onClose}>
          <Button
            type="submit"
            loading={flow.preview.busy || flow.confirm.busy}
            data-testid="habit-schedule-submit"
          >
            {flow.previewed ? t("confirmChange") : t("showPreview")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Sets, changes or clears the end date of the current tracking period, with a preview. */
export function EndDateDialog({
  habit,
  onClose,
}: {
  readonly habit: HabitSummary;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const [endsOn, setEndsOn] = useState(habit.endsOn ?? habit.today);
  const flow = usePreviewFlow<{ revision: number; endsOn: string | null }>(
    `habit:${habit.id}`,
    "POST",
    habitEndpoint(habit.id, "end"),
    onClose,
  );
  const send = (value: string | null) => {
    const body = { revision: habit.revision, endsOn: value };
    if (flow.previewed || value === null) flow.confirm.mutate(body);
    else flow.preview.mutate(body);
  };
  const impact = endImpact.safeParse(flow.impact);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("endTitle")}
      description={t("endExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          send(endsOn);
        }}
      >
        <TextField
          label={t("fieldEndsOn")}
          type="date"
          min={habit.periodStartsOn}
          value={endsOn}
          onChange={(event) => {
            flow.clear();
            setEndsOn(event.target.value);
          }}
          data-testid="habit-end-on"
        />
        {impact.success ? (
          <Preview>
            <p className="text-body text-fg">
              {impact.data.endsOn
                ? t("previewEndsOn", { date: texts.date(impact.data.endsOn, "short") })
                : t("previewNoEnd")}
            </p>
            {impact.data.inPast ? (
              <p className="text-body text-fg">{t("previewEndInPast")}</p>
            ) : null}
            {impact.data.checkinsAfter > 0 ? (
              <p className="text-body text-danger">
                {t("previewCheckinsAfter", { count: impact.data.checkinsAfter })}
              </p>
            ) : null}
            {impact.data.lastScheduled ? (
              <p className="text-body text-fg">
                {t("previewLastScheduled", {
                  date: texts.date(impact.data.lastScheduled, "short"),
                })}
              </p>
            ) : null}
          </Preview>
        ) : null}
        <Failure error={flow.error} />
        <DialogActions onClose={onClose}>
          {habit.endsOn ? (
            <Button
              variant="ghost"
              loading={flow.confirm.busy && flow.confirm.variables?.endsOn === null}
              onClick={() => {
                send(null);
              }}
              data-testid="habit-end-clear"
            >
              {t("clearEnd")}
            </Button>
          ) : null}
          <Button
            type="submit"
            loading={
              flow.preview.busy || (flow.confirm.busy && flow.confirm.variables?.endsOn !== null)
            }
            data-testid="habit-end-submit"
          >
            {flow.previewed ? t("confirmChange") : t("showPreview")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Starts a manual pause from today: until a resume date, or until resumed. */
export function PauseDialog({
  habit,
  onClose,
}: {
  readonly habit: HabitSummary;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const [open, setOpen] = useState(true);
  const [resumesOn, setResumesOn] = useState("");
  const flow = usePreviewFlow(
    `habit:${habit.id}`,
    "POST",
    habitEndpoint(habit.id, "pauses"),
    onClose,
  );
  const body = { revision: habit.revision, resumesOn: open || resumesOn === "" ? null : resumesOn };
  const impact = pauseImpact.safeParse(flow.impact);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("pauseTitle")}
      description={t("pauseExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (flow.previewed) flow.confirm.mutate(body);
          else flow.preview.mutate(body);
        }}
      >
        <Checkbox
          label={t("pauseUntilResumed")}
          checked={open}
          onChange={(event) => {
            flow.clear();
            setOpen(event.target.checked);
          }}
          data-testid="habit-pause-open"
        />
        {!open ? (
          <TextField
            label={t("fieldResumesOn")}
            description={t("fieldResumesOnHint")}
            type="date"
            value={resumesOn}
            onChange={(event) => {
              flow.clear();
              setResumesOn(event.target.value);
            }}
            data-testid="habit-resumes-on"
          />
        ) : null}
        {impact.success ? (
          <Preview>
            <p className="text-body text-fg">
              {impact.data.resumesOn
                ? t("previewPauseUntil", {
                    from: texts.date(impact.data.startsOn, "short"),
                    to: texts.date(impact.data.resumesOn, "short"),
                  })
                : t("previewPauseOpen", { from: texts.date(impact.data.startsOn, "short") })}
            </p>
            <p className="text-body text-fg">
              {impact.data.resumesOn
                ? t("previewPausedDays", { count: impact.data.scheduledDays })
                : t("previewPausedDaysOpen", { count: impact.data.scheduledDays })}
            </p>
            <p className="text-body text-fg">{t("previewStreakSafe")}</p>
            {impact.data.todayDone ? (
              <p className="text-body text-fg">{t("previewTodayKept")}</p>
            ) : null}
            {impact.data.reminders ? (
              <p className="text-body text-fg">{t("previewRemindersPaused")}</p>
            ) : null}
            <RangeList label={t("previewVacationDays")} items={impact.data.vacationDays ?? []} />
          </Preview>
        ) : null}
        <Failure error={flow.error} />
        <DialogActions onClose={onClose}>
          <Button
            type="submit"
            disabled={!open && resumesOn === ""}
            loading={flow.preview.busy || flow.confirm.busy}
            data-testid="habit-pause-submit"
          >
            {flow.previewed ? t("confirmPause") : t("showPreview")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Resumes a current pause now, or moves its resume date (tomorrow or later, or until resumed). */
export function PauseChangeDialog({
  habit,
  onClose,
}: {
  readonly habit: HabitSummary & { readonly pause: NonNullable<HabitSummary["pause"]> };
  readonly onClose: () => void;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const pause = habit.pause;
  const [resumesOn, setResumesOn] = useState(pause.resumesOn ?? "");
  const flow = usePreviewFlow<{
    revision: number;
    action: "resume" | "change";
    resumesOn: string | null;
  }>(`habit:${habit.id}`, "PATCH", habitPauseEndpoint(habit.id, pause.id), onClose);
  const impact = pauseChangeImpact.safeParse(flow.impact);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("pauseChangeTitle")}
      description={
        pause.resumesOn
          ? t("pauseChangeCurrent", { date: texts.date(pause.resumesOn, "short") })
          : t("pauseChangeCurrentOpen")
      }
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Button
            loading={flow.confirm.busy && flow.confirm.variables?.action === "resume"}
            onClick={() => {
              flow.confirm.mutate({ revision: pause.revision, action: "resume", resumesOn: null });
            }}
            data-testid="habit-resume-now"
          >
            {t("resumeNow")}
          </Button>
          <p className="text-helper text-fg-muted">{t("resumeNowHint")}</p>
        </div>
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const body = {
              revision: pause.revision,
              action: "change" as const,
              resumesOn: resumesOn === "" ? null : resumesOn,
            };
            if (flow.previewed) flow.confirm.mutate(body);
            else flow.preview.mutate(body);
          }}
        >
          <TextField
            label={t("fieldResumesOn")}
            description={t("fieldResumesOnChangeHint")}
            type="date"
            value={resumesOn}
            onChange={(event) => {
              flow.clear();
              setResumesOn(event.target.value);
            }}
            data-testid="habit-pause-resumes-on"
          />
          {impact.success ? (
            <Preview>
              <p className="text-body text-fg">
                {impact.data.resumesOn
                  ? t("previewResumesOn", { date: texts.date(impact.data.resumesOn, "short") })
                  : t("previewPauseOpen", { from: texts.date(impact.data.startsOn, "short") })}
              </p>
              {impact.data.vacationToday ? (
                <p className="text-body text-fg">{t("previewVacationStillPauses")}</p>
              ) : null}
            </Preview>
          ) : null}
          <Failure error={flow.error} />
          <DialogActions onClose={onClose}>
            <Button
              type="submit"
              loading={
                flow.preview.busy ||
                (flow.confirm.busy && flow.confirm.variables?.action === "change")
              }
              data-testid="habit-pause-change-submit"
            >
              {flow.previewed ? t("confirmChange") : t("showPreview")}
            </Button>
          </DialogActions>
        </form>
      </div>
    </Dialog>
  );
}

/** Reminder times (up to three) and weekdays as a form edits them. */
function ReminderFields({
  times,
  weekdays,
  onTimes,
  onWeekdays,
  weekStart,
  error,
}: {
  readonly times: readonly string[];
  readonly weekdays: readonly number[];
  readonly onTimes: (times: string[]) => void;
  readonly onWeekdays: (weekdays: number[]) => void;
  readonly weekStart: HabitDetail["weekStart"];
  readonly error?: string | undefined;
}) {
  const t = useTranslations("Habits");
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-body font-medium text-fg">{t("fieldReminderTimes")}</legend>
        {times.map((time, index) => (
          <div key={index} className="flex items-end gap-2">
            <TextField
              label={t("reminderTime", { number: index + 1 })}
              type="time"
              value={time}
              onChange={(event) => {
                onTimes(times.map((other, at) => (at === index ? event.target.value : other)));
              }}
              data-testid={`habit-reminder-time-${String(index)}`}
            />
            {times.length > 1 ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("removeReminderTime", { number: index + 1 })}
                onClick={() => {
                  onTimes(times.filter((_, at) => at !== index));
                }}
              >
                {t("remove")}
              </Button>
            ) : null}
          </div>
        ))}
        {times.length < HABIT_LIMITS.reminderTimes ? (
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onTimes([...times, "20:00"]);
              }}
            >
              {t("addReminderTime")}
            </Button>
          </div>
        ) : null}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-body font-medium text-fg">{t("fieldReminderDays")}</legend>
        <div className="flex flex-wrap gap-3">
          {habitWeekdayOrder(weekStart).map((day) => (
            <label key={day} className="flex items-center gap-1.5 text-body text-fg">
              <input
                type="checkbox"
                checked={weekdays.includes(day)}
                className="size-4 accent-accent"
                onChange={(event) => {
                  onWeekdays(
                    event.target.checked
                      ? [...weekdays, day]
                      : weekdays.filter((other) => other !== day),
                  );
                }}
              />
              {formatWeekday(day, locale, "long")}
            </label>
          ))}
        </div>
      </fieldset>
      {error ? (
        <p className="text-helper text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const allDays = [1, 2, 3, 4, 5, 6, 7];

function validReminder(times: readonly string[], weekdays: readonly number[]): boolean {
  return (
    times.length > 0 &&
    times.every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) &&
    new Set(times).size === times.length &&
    weekdays.length > 0
  );
}

/** A habit's reminders: off by default; up to three local times on chosen weekdays. */
export function RemindersDialog({
  habit,
  onClose,
}: {
  readonly habit: HabitDetail;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const [enabled, setEnabled] = useState(habit.reminder?.enabled ?? false);
  const [times, setTimes] = useState<string[]>(habit.reminder?.times ?? ["20:00"]);
  const [weekdays, setWeekdays] = useState<number[]>(
    habit.reminder?.weekdays ??
      (habit.schedule?.kind === "weekdays" ? [...habit.schedule.weekdays] : allDays),
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const save = useHabitMutation(
    `habit-reminders:${habit.id}`,
    (body: object) => sendHabitRequest("PUT", habitEndpoint(habit.id, "reminders"), body),
    onClose,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("remindersTitle")}
      description={t("remindersExplanation", { zone: habit.timeZone })}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (enabled && !validReminder(times, weekdays)) {
            setError(texts.field("timesRequired"));
            return;
          }
          setError(undefined);
          save.mutate({
            expectedRevision: habit.reminder?.revision ?? 0,
            enabled,
            times: enabled ? [...times].sort() : null,
            weekdays: enabled ? [...weekdays].sort((a, b) => a - b) : null,
          });
        }}
      >
        <Checkbox
          label={t("remindersOn")}
          description={habit.homeId ? t("remindersOnHomeHint") : t("remindersOnHint")}
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
          }}
          data-testid="habit-reminders-enabled"
        />
        {enabled ? (
          <ReminderFields
            times={times}
            weekdays={weekdays}
            onTimes={setTimes}
            onWeekdays={setWeekdays}
            weekStart={habit.weekStart}
            error={error}
          />
        ) : null}
        <Failure error={save.error} />
        <DialogActions onClose={onClose}>
          <Button type="submit" loading={save.busy} data-testid="habit-reminders-save">
            {t("save")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/**
 * Reactivates an Ended habit: a new tracking period from today or later, an optional end, its
 * schedule (the last one by default) and a review of its reminders, which never switch on by
 * themselves. A preview comes first; confirming twice makes one period.
 */
export function ReactivateDialog({
  habit,
  onClose,
}: {
  readonly habit: HabitDetail;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const last = habit.schedules.at(-1) ?? habit.schedule;
  const [startsOn, setStartsOn] = useState(habit.today);
  const [endsOn, setEndsOn] = useState("");
  const [draft, setDraft] = useState<ScheduleDraft>({
    kind: last?.kind ?? "daily",
    weekdays: last?.weekdays ?? [],
    target: last?.target ?? 3,
  });
  const had = habit.reminder;
  const [mode, setMode] = useState<"keep" | "change" | "off">(had?.enabled ? "keep" : "off");
  const [times, setTimes] = useState<string[]>(had?.times ?? ["20:00"]);
  const [weekdays, setWeekdays] = useState<number[]>(had?.weekdays ?? allDays);
  const [error, setError] = useState<string | undefined>(undefined);
  const flow = usePreviewFlow(
    `habit:${habit.id}`,
    "POST",
    habitEndpoint(habit.id, "reactivate"),
    onClose,
  );
  const impact = reactivateImpact.safeParse(flow.impact);
  const body = {
    revision: habit.revision,
    startsOn,
    endsOn: endsOn === "" ? null : endsOn,
    schedule: scheduleBody(draft),
    reminder:
      mode === "change"
        ? { mode, times: [...times].sort(), weekdays: [...weekdays].sort((a, b) => a - b) }
        : { mode, times: null, weekdays: null },
  };
  const modes: readonly { readonly value: "keep" | "change" | "off"; readonly label: string }[] = [
    ...(had?.enabled ? [{ value: "keep" as const, label: t("reminderKeep") }] : []),
    { value: "change", label: had?.enabled ? t("reminderChange") : t("reminderSet") },
    { value: "off", label: had?.enabled ? t("reminderOff") : t("reminderStayOff") },
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("reactivateTitle")}
      description={t("reactivateExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.kind === "weekdays" && draft.weekdays.length === 0) {
            setError(texts.field("weekdaysRequired"));
            return;
          }
          if (mode === "change" && !validReminder(times, weekdays)) {
            setError(texts.field("timesRequired"));
            return;
          }
          setError(undefined);
          if (flow.previewed) flow.confirm.mutate(body);
          else flow.preview.mutate(body);
        }}
      >
        <TextField
          label={t("fieldStartsOn")}
          description={t("fieldReactivateStartHint")}
          type="date"
          min={habit.today}
          value={startsOn}
          onChange={(event) => {
            flow.clear();
            setStartsOn(event.target.value);
          }}
          data-testid="habit-reactivate-start"
        />
        <TextField
          label={t("fieldEndsOn")}
          description={t("fieldEndsOnHint")}
          type="date"
          value={endsOn}
          onChange={(event) => {
            flow.clear();
            setEndsOn(event.target.value);
          }}
        />
        <HabitScheduleFields
          value={draft}
          onChange={(next) => {
            flow.clear();
            setDraft(next);
          }}
          weekStart={habit.weekStart}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body font-medium text-fg">{t("reviewReminders")}</legend>
          <p className="text-helper text-fg-muted">
            {had?.enabled
              ? t("reviewRemindersWere", {
                  times: had.times.join(", "),
                  days: texts.weekdays(had.weekdays),
                })
              : t("reviewRemindersOff")}
          </p>
          {modes.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-body text-fg">
              <input
                type="radio"
                name="reminder-mode"
                value={option.value}
                checked={mode === option.value}
                className="size-4 accent-accent"
                onChange={() => {
                  flow.clear();
                  setMode(option.value);
                }}
                data-testid={`habit-reminder-mode-${option.value}`}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        {mode === "change" ? (
          <ReminderFields
            times={times}
            weekdays={weekdays}
            onTimes={(next) => {
              flow.clear();
              setTimes(next);
            }}
            onWeekdays={(next) => {
              flow.clear();
              setWeekdays(next);
            }}
            weekStart={habit.weekStart}
          />
        ) : null}
        {error ? (
          <p className="text-helper text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {impact.success ? (
          <Preview>
            <p className="text-body text-fg">
              {impact.data.endsOn
                ? t("previewReactivateUntil", {
                    from: texts.date(impact.data.startsOn, "short"),
                    to: texts.date(impact.data.endsOn, "short"),
                  })
                : t("previewReactivateFrom", { from: texts.date(impact.data.startsOn, "short") })}
            </p>
            <p className="text-body text-fg">{t("previewFreshStreak")}</p>
            <p className="text-body text-fg">
              {texts.longest({
                longestOccurrences: impact.data.longest.occurrences,
                longestWeeks: impact.data.longest.weeks,
              })}
            </p>
            {impact.data.previousReminder && !impact.data.previousReminder.fitsSchedule ? (
              <p className="text-body text-fg">{t("previewReminderNoDays")}</p>
            ) : null}
            <DateList dates={impact.data.nextDates ?? []} />
            <RangeList label={t("previewPauses")} items={impact.data.pauses ?? []} />
          </Preview>
        ) : null}
        <Failure error={flow.error} />
        <DialogActions onClose={onClose}>
          <Button
            type="submit"
            loading={flow.preview.busy || flow.confirm.busy}
            data-testid="habit-reactivate-submit"
          >
            {flow.previewed ? t("confirmReactivate") : t("showPreview")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Archives a habit (hidden from lists, widgets and reminders; nothing lost) or brings it back. */
export function ArchiveDialog({
  habit,
  onClose,
}: {
  readonly habit: HabitSummary;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Habits");
  const archived = habit.status === "archived";
  const save = useHabitMutation(
    `habit:${habit.id}`,
    () =>
      sendHabitRequest("POST", habitEndpoint(habit.id, "archive"), {
        revision: habit.revision,
        archived: !archived,
      }),
    onClose,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={archived ? t("unarchiveTitle") : t("archiveTitle")}
      description={archived ? t("unarchiveExplanation") : t("archiveExplanation")}
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-4">
        <Failure error={save.error} />
        <DialogActions onClose={onClose}>
          <Button
            loading={save.busy}
            onClick={() => {
              save.mutate(undefined);
            }}
            data-testid="habit-archive-confirm"
          >
            {archived ? t("unarchive") : t("archive")}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

/** Moves a habit to the trash, restorable unchanged for 7 days. */
export function DeleteDialog({
  habit,
  onClose,
}: {
  readonly habit: HabitSummary;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Habits");
  const router = useRouter();
  const toast = useToast();
  const remove = useHabitMutation(
    `habit:${habit.id}`,
    () => sendHabitRequest("DELETE", habitEndpoint(habit.id), { revision: habit.revision }),
    () => {
      toast.show({ title: t("deletedToast", { habit: habit.name }), tone: "info" });
      router.push(habitsPath(habit.homeId));
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("deleteTitle")}
      description={t("deleteExplanation", { habit: habit.name })}
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-4">
        <Failure error={remove.error} />
        <DialogActions onClose={onClose}>
          <Button
            variant="destructive"
            loading={remove.busy}
            onClick={() => {
              remove.mutate(undefined);
            }}
            data-testid="habit-delete-confirm"
          >
            {t("delete")}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

/** A habit manager's correction: undoes someone's (or an older) check-in, with an optional reason. */
export function CorrectDialog({
  checkin,
  habitName,
  onClose,
}: {
  readonly checkin: HabitCheckin;
  readonly habitName: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const checkins = useHabitCheckins(`habit-correct:${checkin.id}`);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("correctTitle")}
      description={t("correctExplanation", { date: texts.date(checkin.onDate, "short") })}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = habitReasonSchema.safeParse(reason);
          if (!parsed.success) {
            setError(texts.field(parsed.error.issues[0]?.message));
            return;
          }
          setError(undefined);
          checkins.undo.mutate(
            { checkin, name: habitName, reason: parsed.data },
            { onSuccess: onClose },
          );
        }}
      >
        <TextArea
          label={t("fieldReason")}
          description={t("fieldReasonHint", { max: HABIT_LIMITS.reason })}
          rows={2}
          value={reason}
          error={error}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          data-testid="habit-correct-reason"
        />
        {checkins.failureText ? (
          <FormAlert tone="error" announce>
            {checkins.failureText}
          </FormAlert>
        ) : null}
        <DialogActions onClose={onClose}>
          <Button type="submit" loading={checkins.undo.busy} data-testid="habit-correct-confirm">
            {t("correct")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Adds, edits or removes the note of the viewer's own check-in (plain text, never shown in email). */
export function NoteDialog({
  checkin,
  onClose,
}: {
  readonly checkin: HabitCheckin;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const [note, setNote] = useState(checkin.note ?? "");
  const [error, setError] = useState<string | undefined>(undefined);
  const save = useHabitMutation(
    `habit-note:${checkin.id}`,
    (value: string | null) =>
      sendHabitRequest("PATCH", habitCheckinEndpoint(checkin.id, "note"), {
        revision: checkin.noteRevision,
        note: value,
      }),
    onClose,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("noteTitle")}
      description={t("noteExplanation", { date: texts.date(checkin.onDate, "short") })}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = habitNoteSchema.safeParse(note);
          if (!parsed.success) {
            setError(texts.field(parsed.error.issues[0]?.message));
            return;
          }
          setError(undefined);
          save.mutate(parsed.data);
        }}
      >
        <TextArea
          label={t("fieldNote")}
          description={t("fieldNoteHint", { max: HABIT_LIMITS.note })}
          rows={3}
          value={note}
          error={error}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          data-testid="habit-note"
        />
        <Failure error={save.error} />
        <DialogActions onClose={onClose}>
          <Button type="submit" loading={save.busy} data-testid="habit-note-save">
            {t("save")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/**
 * Confirms a completion for an earlier day (backdating, at most 7 days back): the day, its state
 * now and that the check-in is recorded today for that day. The parent sends it, so its
 * confirmation and Undo work as for today.
 */
export function BackdateDialog({
  habitName,
  day,
  today,
  busy,
  onConfirm,
  onClose,
}: {
  readonly habitName: string;
  readonly day: HabitDay;
  readonly today: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const date = texts.date(day.onDate, "long");
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("backdateTitle", { habit: habitName })}
      description={t("backdateExplanation")}
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-4">
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body"
          data-testid="habit-backdate"
        >
          <dt className="font-medium text-fg">{t("backdateDay")}</dt>
          <dd className="text-fg">{date}</dd>
          <dt className="font-medium text-fg">{t("backdateState")}</dt>
          <dd className="text-fg">{texts.state(day.state)}</dd>
          <dt className="font-medium text-fg">{t("backdateRecorded")}</dt>
          <dd className="text-fg">{texts.date(today, "long")}</dd>
        </dl>
        <DialogActions onClose={onClose}>
          <Button loading={busy} onClick={onConfirm} data-testid="habit-backdate-confirm">
            {t("markCompleted")}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
