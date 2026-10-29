"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { HABIT_LIMITS, habitWeekStarts, type HabitWeekStart } from "@madeora/domain/habits";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { HABITS_ENDPOINT, habitEndpoint, sendHabitRequest, type HabitSummary } from "@/habits/api";
import { habitsPath, newId } from "@/habits/format";
import { createHabitSchema, updateHabitSchema } from "@/habits/schema";
import {
  defaultTrackingDraft,
  trackingFromDraft,
  type TrackingDraft,
  type TrackingErrors,
} from "@/habits/tracking-draft";

import {
  defaultSchedule,
  HabitScheduleFields,
  scheduleBody,
  type ScheduleDraft,
} from "./habit-schedule-fields";
import { TrackingFields } from "./numeric-fields";
import { useHabitMutation } from "./use-habit-mutation";
import { useHabitTexts } from "./use-habit-texts";

interface FormValues {
  name: string;
  description: string;
  startsOn: string;
  endsOn: string;
  timeZone: string;
  weekStart: HabitWeekStart;
}

type Field = keyof FormValues;
const fields: readonly Field[] = [
  "name",
  "description",
  "startsOn",
  "endsOn",
  "timeZone",
  "weekStart",
];

function isField(value: unknown): value is Field {
  return typeof value === "string" && (fields as readonly string[]).includes(value);
}

export interface HabitFormDialogProps {
  /** null: a new habit. */
  readonly habit: HabitSummary | null;
  readonly homeId: string | null;
  /** The context's today, the first default start date. */
  readonly today: string;
  /** The viewer's week start, the default for a new habit. */
  readonly weekStart: HabitWeekStart;
  /** For personal habits: the viewer's effective timezone and the zones to offer. */
  readonly timeZone: string;
  readonly timeZones: readonly string[];
  readonly onClose: () => void;
}

/**
 * Creates a habit (name, schedule, start and optional end date, description, week start and, for a
 * personal habit, its timezone) or edits one's name, description and timezone. A schedule, end date
 * or pause changes elsewhere, with a preview. Errors are shown at their fields and focus moves to
 * the first one.
 */
export function HabitFormDialog({
  habit,
  homeId,
  today,
  weekStart,
  timeZone,
  timeZones,
  onClose,
}: HabitFormDialogProps) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const router = useRouter();
  const locale = useLocale();
  const [id] = useState(newId);
  const [tracking, setTracking] = useState<TrackingDraft>(() => defaultTrackingDraft(locale));
  const [trackingErrors, setTrackingErrors] = useState<TrackingErrors | undefined>(undefined);
  const [schedule, setSchedule] = useState<ScheduleDraft>(defaultSchedule);
  const [scheduleError, setScheduleError] = useState<string | undefined>(undefined);
  const personal = (habit ? habit.homeId : homeId) === null;
  const form = useForm<FormValues>({
    defaultValues: {
      name: habit?.name ?? "",
      description: habit?.description ?? "",
      startsOn: today,
      endsOn: "",
      timeZone: habit?.timeZone ?? timeZone,
      weekStart: habit?.weekStart ?? weekStart,
    },
  });
  const errors = form.formState.errors;
  const chosenWeekStart = useWatch({ control: form.control, name: "weekStart" });
  const save = useHabitMutation(
    `habit:${habit?.id ?? id}`,
    (body: object) =>
      habit
        ? sendHabitRequest("PATCH", habitEndpoint(habit.id), body)
        : sendHabitRequest("POST", HABITS_ENDPOINT, body),
    () => {
      onClose();
      if (!habit) router.push(habitsPath(homeId, id));
    },
  );

  const submit = (values: FormValues) => {
    setTrackingErrors(undefined);
    // A weekly schedule is always completed once; numeric targets are daily.
    const numeric = !habit && tracking.numeric && schedule.kind !== "weekly";
    const reading = trackingFromDraft({ ...tracking, numeric }, locale);
    if (!reading.ok) {
      setTrackingErrors(reading.errors);
      return;
    }
    const body = habit
      ? {
          revision: habit.revision,
          name: values.name,
          description: values.description,
          timeZone: personal ? values.timeZone : null,
        }
      : {
          id,
          homeId,
          name: values.name,
          description: values.description,
          schedule: scheduleBody(schedule),
          startsOn: values.startsOn,
          endsOn: values.endsOn === "" ? null : values.endsOn,
          timeZone: personal ? values.timeZone : null,
          weekStart: values.weekStart,
          tracking: reading.tracking,
        };
    const parsed = (habit ? updateHabitSchema : createHabitSchema).safeParse(body);
    form.clearErrors();
    setScheduleError(undefined);
    let first: Field | null = null;
    if (!habit && schedule.kind === "weekdays" && schedule.weekdays.length === 0) {
      setScheduleError(texts.field("weekdaysRequired"));
    }
    if (!habit && values.endsOn !== "" && values.endsOn < values.startsOn) {
      form.setError("endsOn", { message: "endBeforeStart" });
      first = "endsOn";
    }
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "schedule") setScheduleError(texts.field("weekdaysRequired"));
        if (isField(field) && !form.getFieldState(field).error) {
          form.setError(field, { message: issue.message });
          first ??= field;
        }
      }
    }
    if (first) form.setFocus(first);
    if (!parsed.success || first) return;
    save.mutate(parsed.data);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={habit ? t("editTitle") : t("newTitle")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void form.handleSubmit(submit)(event);
        }}
        data-testid="habit-form"
      >
        <TextField
          label={t("fieldName")}
          description={t("fieldNameHint", { max: HABIT_LIMITS.name })}
          autoComplete="off"
          error={errors.name ? texts.field(errors.name.message) : undefined}
          data-testid="habit-name"
          {...form.register("name")}
        />
        <TextArea
          label={t("fieldDescription")}
          description={t("fieldOptional")}
          rows={3}
          error={errors.description ? texts.field(errors.description.message) : undefined}
          data-testid="habit-description"
          {...form.register("description")}
        />
        {habit ? null : (
          <>
            <HabitScheduleFields
              value={schedule}
              onChange={setSchedule}
              weekStart={chosenWeekStart}
              error={scheduleError}
            />
            <TrackingFields
              value={tracking}
              onChange={setTracking}
              weekly={schedule.kind === "weekly"}
              errors={trackingErrors}
            />
            <TextField
              label={t("fieldStartsOn")}
              description={t("fieldStartsOnHint", { days: HABIT_LIMITS.startPastDays })}
              type="date"
              error={errors.startsOn ? texts.field(errors.startsOn.message) : undefined}
              data-testid="habit-starts-on"
              {...form.register("startsOn")}
            />
            <TextField
              label={t("fieldEndsOn")}
              description={t("fieldEndsOnHint")}
              type="date"
              error={errors.endsOn ? texts.field(errors.endsOn.message) : undefined}
              data-testid="habit-ends-on"
              {...form.register("endsOn")}
            />
            <SelectField
              label={t("fieldWeekStart")}
              description={t("fieldWeekStartHint")}
              options={habitWeekStarts.map((value) => ({
                value,
                label: texts.weekStart(value),
              }))}
              data-testid="habit-week-start"
              {...form.register("weekStart")}
            />
          </>
        )}
        {personal ? (
          <SelectField
            label={t("fieldTimeZone")}
            description={t("fieldTimeZoneHint")}
            options={timeZones.map((zone) => ({ value: zone, label: zone }))}
            error={errors.timeZone ? texts.field(errors.timeZone.message) : undefined}
            data-testid="habit-time-zone"
            {...form.register("timeZone")}
          />
        ) : null}
        {save.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(save.error.failure)}
          </FormAlert>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={save.busy} data-testid="habit-save">
            {habit ? t("save") : t("create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
