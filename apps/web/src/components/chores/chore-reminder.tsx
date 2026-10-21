"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_OCCURRENCES_ENDPOINT,
  sendChoreRequest,
  type ChoreReminderPreview,
  type ChoreReminderView,
} from "@/chores/api";
import { CHORE_SCHEDULE_LIMITS, type ChoreReminderInput } from "@/chores/schema";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import { formatTaskDate, noMembers } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

type Mode = "relative" | "absolute";
type Draft = { readonly mode: Mode } & (
  | { readonly mode: "relative"; readonly daysBefore: number; readonly time: string }
  | { readonly mode: "absolute"; readonly localAt: string }
);

/** The form's starting values: the reminder as it is, or the day before at 18:00. */
function draftOf(view: ChoreReminderView): {
  mode: Mode;
  days: string;
  time: string;
  localAt: string;
} {
  const reminder = view.reminder;
  return {
    mode: reminder?.mode ?? "relative",
    days: String(reminder?.daysBefore ?? 1),
    time: reminder?.time ?? "18:00",
    localAt: reminder?.localAt?.slice(0, 16) ?? `${view.dueDate}T09:00`,
  };
}

/**
 * The person's own reminder on a chore they are assigned to (S21; spec "Confirmed individual chore
 * reminders"): at a date and time, or a number of days before the due day at a time they choose,
 * in the Home's timezone. The server previews the moment (daylight saving included) before it is
 * saved. Nobody else sees it; it ends when the person is no longer assigned or the chore closes.
 */
export function ChoreReminder({
  occurrenceId,
  view,
  formats,
}: {
  readonly occurrenceId: string;
  readonly view: ChoreReminderView;
  readonly formats: DateTimeFormats;
}) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const { announce, region } = useAnnouncer();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => draftOf(view));
  const [preview, setPreview] = useState<ChoreReminderPreview | null>(null);
  const [daysError, setDaysError] = useState(false);
  const url = `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}/reminder`;
  const save = useChoreMutation(
    `chore-reminder:${occurrenceId}`,
    (input: ChoreReminderInput) => sendChoreRequest<ChoreReminderPreview>("PUT", url, input),
    (result, input) => {
      if (input.dryRun) {
        setPreview(result);
        return;
      }
      setEditing(false);
      setPreview(null);
      announce(t("announceReminderSaved"));
    },
    { refresh: (_result, input) => !input.dryRun },
  );
  const remove = useChoreMutation(
    `chore-reminder:${occurrenceId}`,
    () => sendChoreRequest("DELETE", url, { expectedRevision: view.revision }),
    () => {
      announce(t("announceReminderRemoved"));
    },
  );
  const reminder = view.reminder;
  if (!view.canSet && !reminder) return null;

  const draft = (): Draft | null => {
    if (form.mode === "absolute") {
      return form.localAt === "" ? null : { mode: "absolute", localAt: form.localAt };
    }
    const days = Number(form.days);
    if (!Number.isInteger(days) || days < 0 || days > CHORE_SCHEDULE_LIMITS.reminderDays) {
      setDaysError(true);
      return null;
    }
    return { mode: "relative", daysBefore: days, time: form.time };
  };
  const send = (dryRun: boolean) => {
    const value = draft();
    if (!value) return;
    save.mutate({ ...value, expectedRevision: view.revision, dryRun });
  };
  const describe = (fireAt: string, dst: "gap" | "overlap" | null) =>
    [
      t("reminderAt", { date: formatDateTime(fireAt, formats) }),
      dst === "gap" ? t("reminderDstGap") : dst === "overlap" ? t("reminderDstOverlap") : null,
    ]
      .filter(Boolean)
      .join(" ");
  const error = save.error ?? remove.error;

  return (
    <section
      aria-labelledby="chore-reminder-heading"
      className="flex flex-col gap-3"
      data-testid="chore-reminder"
    >
      {region}
      <h2 id="chore-reminder-heading" className="text-section-title font-semibold text-fg">
        {t("reminderHeading")}
      </h2>
      {reminder ? (
        <p className="text-body text-fg" data-testid="chore-reminder-current">
          {reminder.mode === "relative"
            ? t("reminderRelative", { count: reminder.daysBefore ?? 0, time: reminder.time ?? "" })
            : t("reminderAbsolute")}{" "}
          {reminder.status === "sent"
            ? t("reminderSent", { date: formatDateTime(reminder.fireAt, formats) })
            : describe(reminder.fireAt, reminder.dst)}
        </p>
      ) : (
        <p className="text-body text-fg-muted">{t("reminderNone")}</p>
      )}
      {!view.channels.inApp && !view.channels.email ? (
        <p className="text-helper text-fg-muted">
          {t("reminderChannelsOff")}{" "}
          <Link href="/settings/notifications" className="font-medium text-accent-fg underline">
            {t("reminderChannelsLink")}
          </Link>
        </p>
      ) : null}
      <HydrationGate>
        {view.canSet && !editing ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setForm(draftOf(view));
                setPreview(null);
                setDaysError(false);
                save.reset();
                setEditing(true);
              }}
              data-testid="chore-reminder-edit"
            >
              {reminder ? t("reminderChange") : t("reminderAdd")}
            </Button>
            {reminder && reminder.status === "scheduled" ? (
              <Button
                variant="ghost"
                loading={remove.busy}
                onClick={() => {
                  remove.mutate(undefined);
                }}
                data-testid="chore-reminder-remove"
              >
                {t("reminderRemove")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {editing ? (
          <form
            noValidate
            className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
            onSubmit={(event) => {
              event.preventDefault();
              send(preview === null);
            }}
            data-testid="chore-reminder-form"
          >
            <fieldset className="flex flex-col gap-2" disabled={preview !== null}>
              <legend className="text-body font-medium text-fg">{t("reminderWhen")}</legend>
              {(["relative", "absolute"] as const).map((mode) => (
                <label key={mode} className="flex min-h-6 items-center gap-2 text-body text-fg">
                  <input
                    type="radio"
                    name="chore-reminder-mode"
                    value={mode}
                    checked={form.mode === mode}
                    onChange={() => {
                      setForm({ ...form, mode });
                    }}
                    className="size-5 accent-accent"
                  />
                  {mode === "relative" ? t("reminderModeRelative") : t("reminderModeAbsolute")}
                </label>
              ))}
              {form.mode === "relative" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={CHORE_SCHEDULE_LIMITS.reminderDays}
                    label={t("reminderDays")}
                    description={t("reminderDaysHelp", {
                      max: CHORE_SCHEDULE_LIMITS.reminderDays,
                      date: formatTaskDate(view.dueDate, formats),
                    })}
                    value={form.days}
                    error={
                      daysError
                        ? t("reminderDaysError", { max: CHORE_SCHEDULE_LIMITS.reminderDays })
                        : undefined
                    }
                    onChange={(event) => {
                      setDaysError(false);
                      setForm({ ...form, days: event.target.value });
                    }}
                    data-testid="chore-reminder-days"
                  />
                  <TextField
                    type="time"
                    label={t("reminderTime")}
                    value={form.time}
                    onChange={(event) => {
                      setForm({ ...form, time: event.target.value });
                    }}
                    data-testid="chore-reminder-time"
                  />
                </div>
              ) : (
                <TextField
                  type="datetime-local"
                  label={t("reminderDateTime")}
                  description={t("reminderTimeZone", { zone: view.timeZone })}
                  value={form.localAt}
                  onChange={(event) => {
                    setForm({ ...form, localAt: event.target.value });
                  }}
                  className="max-w-72"
                  data-testid="chore-reminder-at"
                />
              )}
            </fieldset>
            {preview?.fireAt ? (
              <p className="text-body text-fg" role="status" data-testid="chore-reminder-preview">
                {describe(preview.fireAt, preview.dst)}
              </p>
            ) : null}
            {error ? (
              <FormAlert tone="error" announce>
                {error.failure === "inPast"
                  ? t("errorReminderInPast")
                  : texts.failure(error.failure, error.detail)}
              </FormAlert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                loading={save.busy}
                data-testid={preview ? "chore-reminder-save" : "chore-reminder-preview-button"}
              >
                {preview ? t("reminderSave") : t("reminderPreview")}
              </Button>
              {preview ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPreview(null);
                  }}
                >
                  {t("reminderBack")}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setPreview(null);
                  save.reset();
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </form>
        ) : null}
      </HydrationGate>
    </section>
  );
}
