"use client";

import { upcomingDates, type IsoWeekday } from "@madeora/domain/tasks";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { EVENTS_ENDPOINT, eventEndpoint, sendCalendarRequest } from "@/calendar/api";
import { eventPath } from "@/calendar/format";
import {
  CALENDAR_LIMITS,
  calendarReminders,
  createEventSchema,
  updateEventSchema,
  type EventScope,
} from "@/calendar/schema";
import { previewSchema, type EventDetail, type Preview } from "@/calendar/shapes";
import { localTimeKind, nextValidTime } from "@/calendar/time";
import { RadioOption } from "@/components/settings/radio-option";
import {
  noRepeat,
  RepeatFields,
  repeatSchema,
  type RepeatDraft,
} from "@/components/tasks/repeat-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import type { DateFormat } from "@/preferences/schema";
import { formatTaskDate } from "@/tasks/format";

import { CalendarFailureAlert } from "./calendar-failure";
import { useCalendarMutation } from "./use-calendar-mutation";

export interface EventFormMember {
  readonly id: string;
  readonly name: string | null;
  readonly isSelf: boolean;
}

export interface EventFormHome {
  readonly id: string;
  readonly name: string;
}

interface FormValues {
  title: string;
  location: string;
  description: string;
  allDay: boolean;
  startsOn: string;
  endsOn: string;
  startTime: string;
  endTime: string;
  timezone: string;
  repeat: RepeatDraft;
  /** "" for none, or one of the offsets in minutes. */
  reminder: string;
  participants: string[];
  shares: string[];
  scope: EventScope;
}

const fieldNames = [
  "title",
  "location",
  "description",
  "startsOn",
  "endsOn",
  "startTime",
  "endTime",
  "timezone",
  "participants",
  "shares",
] as const;
type Field = (typeof fieldNames)[number];

function isField(value: unknown): value is Field {
  return typeof value === "string" && (fieldNames as readonly string[]).includes(value);
}

/** The date fields of the series or of one occurrence. */
type Times = Pick<FormValues, "allDay" | "startsOn" | "endsOn" | "startTime" | "endTime">;

function timesOf(source: NonNullable<EventDetail["occurrence"]> | EventDetail["series"]): Times {
  return {
    allDay: source.allDay,
    startsOn: source.startsOn,
    endsOn: source.endsOn,
    startTime: source.startTime ?? "09:00",
    endTime: source.endTime ?? "10:00",
  };
}

function isIsoWeekday(value: number): value is IsoWeekday {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}

/** The repeat draft of an event, with what is left of a counted series from `from` on. */
function repeatDraftOf(event: EventDetail, from: string | null): RepeatDraft {
  const repeat = event.repeat;
  if (!repeat) return noRepeat;
  let count = repeat.count;
  if (count !== null && from !== null) {
    const rule = {
      frequency: repeat.frequency,
      interval: repeat.interval,
      weekdays: repeat.weekdays ? repeat.weekdays.filter(isIsoWeekday) : null,
      startsOn: event.series.startsOn,
      endsOn: null,
      count,
    };
    const before = upcomingDates(rule, event.series.startsOn, count).filter((date) => date < from);
    count = Math.max(1, count - before.length);
  }
  return {
    frequency: repeat.frequency,
    interval: String(repeat.interval),
    weekdays: [...(repeat.weekdays ?? [])],
    ends: count !== null ? "after" : repeat.endsOn !== null ? "on" : "never",
    endsOn: repeat.endsOn ?? "",
    count: count !== null ? String(count) : "",
  };
}

/**
 * Adds an event, or changes one (S32): title, all-day or timed with a timezone (the context's by
 * default, changeable to any IANA zone), location, description, repeat, participants (a Home event)
 * or the Homes a personal event is shared with. A recurring event is changed for this event, this
 * and following events, or all events, and every such change first shows the occurrences it affects;
 * nothing changes before the person confirms. The database checks everything again.
 */
export function EventForm({
  homeId,
  defaultTimeZone,
  timeZoneChoices,
  members,
  homes,
  dateFormat,
  initialDate,
  event,
  on,
}: {
  readonly homeId: string | null;
  readonly defaultTimeZone: string;
  readonly timeZoneChoices: readonly string[];
  /** A Home event's possible participants (current members). */
  readonly members: readonly EventFormMember[];
  /** A personal event's Homes to share with (the person's current Homes). */
  readonly homes: readonly EventFormHome[];
  readonly dateFormat: DateFormat;
  readonly initialDate: string;
  /** Absent: a new event. */
  readonly event?: EventDetail;
  /** Editing a recurring event from one occurrence. */
  readonly on?: string;
}) {
  const t = useTranslations("Calendar");
  const scopeLabel = {
    only: t("scope_only"),
    following: t("scope_following"),
    all: t("scope_all"),
  } as const satisfies Record<EventScope, string>;
  const previewText = {
    only: t("preview_only"),
    following: t("preview_following"),
    all: t("preview_all"),
  } as const satisfies Record<EventScope, string>;
  const router = useRouter();
  const [id] = useState(() => crypto.randomUUID());
  const [newId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<{ body: object; preview: Preview } | null>(null);
  const recurring = event?.repeat != null;
  const occurrence = recurring && on ? (event.occurrence ?? null) : null;
  const initialScope: EventScope = occurrence ? "only" : "all";
  const sharesOf = event?.shares ?? [];
  const form = useForm<FormValues>({
    defaultValues: {
      title: (occurrence ?? event?.series)?.title ?? "",
      location: (occurrence ?? event?.series)?.location ?? "",
      description: (occurrence ?? event?.series)?.description ?? "",
      ...(occurrence
        ? timesOf(occurrence)
        : event
          ? timesOf(event.series)
          : {
              allDay: false,
              startsOn: initialDate,
              endsOn: initialDate,
              startTime: "09:00",
              endTime: "10:00",
            }),
      timezone: event?.series.timezone ?? defaultTimeZone,
      repeat: event ? repeatDraftOf(event, occurrence ? (on ?? null) : null) : noRepeat,
      reminder: event?.reminder === null || !event ? "" : String(event.reminder),
      participants: [...((occurrence ?? event?.series)?.participants ?? [])],
      shares: [...sharesOf],
      scope: initialScope,
    },
  });
  const errors = form.formState.errors;
  const [allDay, startsOn, startTime, timezone, scope] = useWatch({
    control: form.control,
    name: ["allDay", "startsOn", "startTime", "timezone", "scope"],
  });

  const save = useCalendarMutation(
    `calendar-event:${event?.id ?? id}`,
    async (input: { body: object; dryRun: boolean }) => {
      const answer = event
        ? await sendCalendarRequest("PATCH", eventEndpoint(event.id), {
            ...input.body,
            ...(input.dryRun ? { dryRun: true } : {}),
          })
        : await sendCalendarRequest("POST", EVENTS_ENDPOINT, input.body);
      return answer;
    },
    (answer, input) => {
      if (input.dryRun) {
        const parsed = previewSchema.safeParse(answer);
        if (parsed.success) setPreview({ body: input.body, preview: parsed.data });
        return;
      }
      const savedId = typeof answer.id === "string" ? answer.id : (event?.id ?? id);
      const values = form.getValues();
      const target =
        event && scope === "only" && on
          ? on
          : values.repeat.frequency !== "none"
            ? values.startsOn
            : null;
      router.push(eventPath(homeId, savedId, target));
    },
  );

  const message = (key: string | undefined) => {
    if (!key) return undefined;
    switch (key) {
      case "required":
        return t("fieldRequired");
      case "tooLong":
        return t("fieldTooLongEvent");
      case "dateOrder":
        return t("fieldDateOrder");
      case "startWeekday":
        return t("fieldStartWeekday");
      case "invalidZone":
        return t("fieldInvalidZone");
      default:
        return t("fieldInvalid");
    }
  };

  const changeScope = (next: EventScope) => {
    if (!event) return;
    form.setValue("scope", next);
    // "All events" changes the series from its own first date; the others from this occurrence.
    const times = next === "all" || !occurrence ? timesOf(event.series) : timesOf(occurrence);
    form.setValue("allDay", times.allDay);
    form.setValue("startsOn", times.startsOn);
    form.setValue("endsOn", times.endsOn);
    form.setValue("startTime", times.startTime);
    form.setValue("endTime", times.endTime);
    form.setValue("repeat", repeatDraftOf(event, next === "all" ? null : (on ?? null)));
    form.setValue("timezone", event.series.timezone);
    setPreview(null);
  };

  const submit = (values: FormValues) => {
    form.clearErrors();
    setPreview(null);
    const repeatParsed = repeatSchema.safeParse(values.repeat);
    if (!repeatParsed.success) {
      for (const issue of repeatParsed.error.issues) {
        const key = issue.path[0];
        const path =
          key === "interval"
            ? "repeat.interval"
            : key === "weekdays"
              ? "repeat.weekdays"
              : key === "endsOn"
                ? "repeat.endsOn"
                : key === "count"
                  ? "repeat.count"
                  : null;
        if (path) form.setError(path, { message: issue.message });
      }
      return;
    }
    const withRepeat = values.scope !== "only";
    const fields = {
      title: values.title,
      location: values.location,
      description: values.description,
      allDay: values.allDay,
      startsOn: values.startsOn,
      endsOn: values.endsOn,
      startTime: values.allDay ? null : values.startTime,
      endTime: values.allDay ? null : values.endTime,
      timezone: values.timezone,
      ...(withRepeat ? { repeat: repeatParsed.data } : {}),
      ...(withRepeat ? { reminder: values.reminder === "" ? null : Number(values.reminder) } : {}),
      ...(homeId ? { participants: values.participants } : {}),
      ...(!homeId && withRepeat ? { shares: values.shares } : {}),
    };
    const parsed = event
      ? updateEventSchema.safeParse({
          revision: event.revision,
          scope: recurring ? values.scope : null,
          on: recurring && values.scope !== "all" ? (on ?? null) : null,
          event: fields,
          ...(recurring && values.scope === "following" ? { newId } : {}),
        })
      : createEventSchema.safeParse({ id, homeId, event: fields });
    if (!parsed.success) {
      let first: Field | null = null;
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === "event" ? issue.path[1] : null;
        if (isField(key) && !form.getFieldState(key).error) {
          const value = values[key];
          form.setError(key, {
            message: value === "" ? "required" : issue.message,
          });
          first ??= key;
        }
      }
      if (first) form.setFocus(first);
      return;
    }
    // A recurring change first shows what it affects; a single event saves at once.
    save.mutate({ body: parsed.data, dryRun: recurring });
  };

  const timeNote =
    !allDay && startsOn && /^\d\d:\d\d$/.test(startTime) && timezone
      ? localTimeKind(startsOn, startTime, timezone)
      : "exists";
  const nextTime = timeNote === "nonexistent" ? nextValidTime(startsOn, startTime, timezone) : null;
  const repeatErrors = errors.repeat;
  const date = (value: string) => formatTaskDate(value, { dateFormat });

  return (
    <form
      noValidate
      className="flex max-w-2xl flex-col gap-4"
      onSubmit={(submitEvent) => {
        void form.handleSubmit(submit)(submitEvent);
      }}
      data-testid="event-form"
    >
      <CalendarFailureAlert error={save.error} />
      {recurring && occurrence ? (
        <fieldset className="flex flex-col gap-1" data-testid="event-scope">
          <legend className="mb-1 text-body font-semibold text-fg">{t("scopeLegend")}</legend>
          {(["only", "following", "all"] as const).map((value) => (
            <RadioOption
              key={value}
              name="scope"
              value={value}
              label={scopeLabel[value]}
              checked={scope === value}
              onChange={() => {
                changeScope(value);
              }}
              data-testid={`event-scope-${value}`}
            />
          ))}
        </fieldset>
      ) : null}
      <TextField
        label={t("fieldTitle")}
        description={t("requiredMax", { max: CALENDAR_LIMITS.title })}
        autoComplete="off"
        required
        error={message(errors.title?.message)}
        data-testid="event-title"
        {...form.register("title")}
      />
      <Checkbox label={t("fieldAllDay")} data-testid="event-all-day" {...form.register("allDay")} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          type="date"
          label={t("fieldStartsOn")}
          required
          error={message(errors.startsOn?.message)}
          data-testid="event-starts-on"
          {...form.register("startsOn", {
            onChange: (change: { target: { value: string } }) => {
              const endsOn = form.getValues("endsOn");
              if (!endsOn || endsOn < change.target.value) {
                form.setValue("endsOn", change.target.value);
              }
            },
          })}
        />
        {!allDay ? (
          <TextField
            type="time"
            label={t("fieldStartTime")}
            required
            error={message(errors.startTime?.message)}
            data-testid="event-start-time"
            {...form.register("startTime")}
          />
        ) : null}
        <TextField
          type="date"
          label={t("fieldEndsOn")}
          required
          error={message(errors.endsOn?.message)}
          data-testid="event-ends-on"
          {...form.register("endsOn")}
        />
        {!allDay ? (
          <TextField
            type="time"
            label={t("fieldEndTime")}
            required
            error={message(errors.endTime?.message)}
            data-testid="event-end-time"
            {...form.register("endTime")}
          />
        ) : null}
      </div>
      {timeNote === "nonexistent" ? (
        <div className="flex flex-wrap items-center gap-2 text-body text-warning" role="status">
          <span>{t("timeNonexistent", { zone: timezone })}</span>
          {nextTime ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                form.setValue("startTime", nextTime);
              }}
              data-testid="event-next-valid-time"
            >
              {t("useTime", { time: nextTime })}
            </Button>
          ) : null}
        </div>
      ) : timeNote === "ambiguous" ? (
        <p className="text-body text-fg-muted" role="status">
          {t("timeAmbiguous", { zone: timezone })}
        </p>
      ) : null}
      {!allDay ? (
        <SelectField
          label={t("fieldTimezone")}
          description={scope === "only" ? t("fieldTimezoneOccurrence") : t("fieldTimezoneHint")}
          disabled={scope === "only" && occurrence !== null}
          options={timeZoneChoices.map((zone) => ({ value: zone, label: zone }))}
          error={message(errors.timezone?.message)}
          data-testid="event-timezone"
          {...form.register("timezone")}
        />
      ) : null}
      <TextField
        label={t("fieldLocation")}
        description={t("optionalMax", { max: CALENDAR_LIMITS.location })}
        autoComplete="off"
        error={message(errors.location?.message)}
        {...form.register("location")}
      />
      <TextArea
        label={t("fieldDescription")}
        description={t("optionalMax", { max: CALENDAR_LIMITS.description })}
        rows={4}
        error={message(errors.description?.message)}
        {...form.register("description")}
      />
      {scope !== "only" ? (
        <Controller
          control={form.control}
          name="repeat"
          render={({ field }) => (
            <RepeatFields
              value={field.value}
              onChange={field.onChange}
              startsOn={startsOn || null}
              errors={{
                interval: repeatErrors?.interval?.message,
                weekdays: repeatErrors?.weekdays?.message ?? repeatErrors?.weekdays?.root?.message,
                endsOn: repeatErrors?.endsOn?.message,
                count: repeatErrors?.count?.message,
              }}
              dateFormat={dateFormat}
              allowNone={!event || !recurring || scope === "following"}
            />
          )}
        />
      ) : (
        <p className="text-helper text-fg-muted">
          {t("occurrenceOnly", { date: on ? date(on) : "" })}
        </p>
      )}
      {scope === "only" ? null : (
        <SelectField
          label={t("fieldReminder")}
          description={homeId ? t("fieldReminderHomeHint") : t("fieldReminderPersonalHint")}
          options={[
            { value: "", label: t("reminderOff") },
            ...calendarReminders.map((value) => ({
              value: String(value),
              label: t("reminderBefore", { minutes: value }),
            })),
          ]}
          data-testid="event-reminder"
          {...form.register("reminder")}
        />
      )}
      {homeId && members.length > 0 ? (
        <fieldset>
          <legend className="mb-1 text-body font-medium text-fg">{t("fieldParticipants")}</legend>
          <p className="mb-2 text-helper text-fg-muted">
            {t("fieldParticipantsHint", { max: CALENDAR_LIMITS.participants })}
          </p>
          <div className="flex flex-col gap-2" data-testid="event-participants">
            {members.map((member) => (
              <Checkbox
                key={member.id}
                value={member.id}
                label={
                  member.isSelf
                    ? t("memberYou", { name: member.name ?? t("memberUnnamed") })
                    : (member.name ?? t("memberUnnamed"))
                }
                {...form.register("participants")}
              />
            ))}
          </div>
          {errors.participants ? (
            <p className="mt-1 text-helper text-danger">{t("fieldInvalid")}</p>
          ) : null}
        </fieldset>
      ) : null}
      {!homeId && homes.length > 0 && scope !== "only" ? (
        <fieldset>
          <legend className="mb-1 text-body font-medium text-fg">{t("fieldShares")}</legend>
          <p className="mb-2 text-helper text-fg-muted">{t("fieldSharesHint")}</p>
          <div className="flex flex-col gap-2" data-testid="event-shares">
            {homes.map((home) => (
              <Checkbox
                key={home.id}
                value={home.id}
                label={home.name}
                {...form.register("shares")}
              />
            ))}
          </div>
        </fieldset>
      ) : null}

      {preview ? (
        <section
          aria-labelledby="event-preview-heading"
          className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
          data-testid="event-preview"
        >
          <h2 id="event-preview-heading" className="text-body font-semibold">
            {t("previewHeading")}
          </h2>
          <p className="text-body">{previewText[preview.preview.scope]}</p>
          <ul className="list-disc ps-6 text-body">
            {preview.preview.dates.map((value) => (
              <li key={value}>{date(value)}</li>
            ))}
          </ul>
          {preview.preview.more || preview.preview.endless ? (
            <p className="text-helper text-fg-muted">{t("previewMore")}</p>
          ) : null}
          {preview.preview.removedChanges ? (
            <p className="text-body text-warning">
              {t("previewRemovedChanges", { count: preview.preview.removedChanges })}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              loading={save.busy}
              onClick={() => {
                save.mutate({ body: preview.body, dryRun: false });
              }}
              data-testid="event-confirm"
            >
              {t("confirmChange")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setPreview(null);
              }}
            >
              {t("back")}
            </Button>
          </div>
        </section>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            router.back();
          }}
        >
          {t("cancel")}
        </Button>
        {!preview ? (
          <Button type="submit" loading={save.busy} data-testid="event-save">
            {event ? (recurring ? t("reviewChange") : t("save")) : t("create")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
