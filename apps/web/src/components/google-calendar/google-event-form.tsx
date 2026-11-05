"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { googleEventPath } from "@/calendar/format";
import { CALENDAR_LIMITS } from "@/calendar/schema";
import { localTimeKind, nextValidTime } from "@/calendar/time";
import { RadioOption } from "@/components/settings/radio-option";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { googleEventEndpoint, sendGoogleRequest } from "@/google-calendar/api";
import { updateGoogleEventSchema, type GoogleScope } from "@/google-calendar/schema";
import type { DateFormat } from "@/preferences/schema";

import { Failure, useGoogleMutation } from "./google-calendar-actions";
import { GooglePreviewList, googlePreviewSchema, type GooglePreview } from "./google-event-actions";

/** The form's starting values, in the event's own timezone (computed on the server). */
export interface GoogleEventValues {
  readonly title: string;
  readonly location: string;
  readonly description: string;
  readonly allDay: boolean;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: string;
}

interface FormValues extends GoogleEventValues {
  scope: GoogleScope;
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
] as const;
type Field = (typeof fieldNames)[number];

function isField(value: unknown): value is Field {
  return typeof value === "string" && (fieldNames as readonly string[]).includes(value);
}

/**
 * Changes one of the person's Google events from Madeora (S34): title, location, description and time.
 * A recurring event changes for this event, this and following events, or all events; a series change
 * keeps each occurrence's date and kind (only the time of day and length move) and first lists the
 * occurrences it affects. The change is saved in Madeora at once and sent to Google by the sync; if Google
 * changed the same field meanwhile, the event page asks the person which version to keep.
 */
export function GoogleEventForm({
  eventId,
  revision,
  recurring,
  values,
  timeZoneChoices,
  dateFormat,
}: {
  readonly eventId: string;
  readonly revision: number;
  readonly recurring: boolean;
  readonly values: GoogleEventValues;
  readonly timeZoneChoices: readonly string[];
  readonly dateFormat: DateFormat;
}) {
  const t = useTranslations("Calendar");
  const tg = useTranslations("GoogleCalendar");
  const router = useRouter();
  const [preview, setPreview] = useState<{ body: object; preview: GooglePreview } | null>(null);
  const form = useForm<FormValues>({ defaultValues: { ...values, scope: "event" } });
  const errors = form.formState.errors;
  const [allDay, startsOn, startTime, timezone, scope] = useWatch({
    control: form.control,
    name: ["allDay", "startsOn", "startTime", "timezone", "scope"],
  });
  const series = scope !== "event";

  const save = useGoogleMutation(
    `google-event:${eventId}`,
    async (input: { body: object; dryRun: boolean }) => {
      const answer = await sendGoogleRequest("PATCH", googleEventEndpoint(eventId), {
        ...input.body,
        ...(input.dryRun ? { dryRun: true } : {}),
      });
      if (input.dryRun) {
        const parsed = googlePreviewSchema.safeParse(answer);
        if (parsed.success) setPreview({ body: input.body, preview: parsed.data });
        return;
      }
      router.push(googleEventPath(null, eventId));
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
      case "invalidZone":
        return t("fieldInvalidZone");
      default:
        return t("fieldInvalid");
    }
  };

  const changeScope = (next: GoogleScope) => {
    form.setValue("scope", next);
    if (next !== "event") {
      // A series change keeps the dates, the kind of event and its zone.
      form.setValue("allDay", values.allDay);
      form.setValue("startsOn", values.startsOn);
      form.setValue("timezone", values.timezone);
    }
    setPreview(null);
  };

  const submit = (input: FormValues) => {
    // Disabled fields may be left out of the values: a series change keeps the series' own.
    const draft =
      input.scope === "event"
        ? input
        : { ...input, allDay: values.allDay, startsOn: values.startsOn, timezone: values.timezone };
    form.clearErrors();
    setPreview(null);
    const parsed = updateGoogleEventSchema.safeParse({
      scope: draft.scope,
      revision,
      event: {
        title: draft.title,
        location: draft.location,
        description: draft.description,
        allDay: draft.allDay,
        startsOn: draft.startsOn,
        endsOn: draft.endsOn,
        startTime: draft.allDay ? null : draft.startTime,
        endTime: draft.allDay ? null : draft.endTime,
        timezone: draft.timezone,
      },
    });
    if (!parsed.success) {
      let first: Field | null = null;
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === "event" ? issue.path[1] : null;
        if (isField(key) && !form.getFieldState(key).error) {
          form.setError(key, { message: draft[key] === "" ? "required" : issue.message });
          first ??= key;
        }
      }
      if (first) form.setFocus(first);
      return;
    }
    save.mutate({ body: parsed.data, dryRun: parsed.data.scope !== "event" });
  };

  const timeNote =
    !allDay && startsOn && /^\d\d:\d\d$/.test(startTime) && timezone
      ? localTimeKind(startsOn, startTime, timezone)
      : "exists";
  const nextTime = timeNote === "nonexistent" ? nextValidTime(startsOn, startTime, timezone) : null;

  return (
    <form
      noValidate
      className="flex max-w-2xl flex-col gap-4"
      onSubmit={(submitEvent) => {
        void form.handleSubmit(submit)(submitEvent);
      }}
      data-testid="google-event-form"
    >
      <Failure error={save.error} about="event" />
      {recurring ? (
        <fieldset className="flex flex-col gap-1" data-testid="google-event-scope">
          <legend className="mb-1 text-body font-semibold text-fg">{tg("scopeLegend")}</legend>
          {(["event", "following", "all"] as const).map((value) => (
            <RadioOption
              key={value}
              name="scope"
              value={value}
              label={tg(`scope_${value}`)}
              checked={scope === value}
              onChange={() => {
                changeScope(value);
              }}
              data-testid={`google-scope-${value}`}
            />
          ))}
          {series ? <p className="text-helper text-fg-muted">{tg("seriesTimeOnly")}</p> : null}
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
      <Checkbox
        label={t("fieldAllDay")}
        disabled={series}
        data-testid="event-all-day"
        {...form.register("allDay")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          type="date"
          label={t("fieldStartsOn")}
          required
          readOnly={series}
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
          description={t("fieldTimezoneHint")}
          disabled={series}
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
      <p className="text-helper text-fg-muted">{tg("editSavesToGoogle")}</p>

      {preview ? (
        <div
          className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
          data-testid="google-event-preview"
        >
          <GooglePreviewList preview={preview.preview} dateFormat={dateFormat} verb="change" />
          <div className="flex flex-wrap gap-2">
            <Button
              loading={save.busy}
              onClick={() => {
                save.mutate({ body: preview.body, dryRun: false });
              }}
              data-testid="google-event-confirm"
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
        </div>
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
          <Button type="submit" loading={save.busy} data-testid="google-event-save">
            {series ? t("reviewChange") : t("save")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
