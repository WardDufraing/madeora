"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { useRecurrenceText } from "@/components/tasks/repeat-fields";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORES_ENDPOINT,
  sendChoreRequest,
  type ChoreNextDate,
  type ChoreSchedule,
  type PauseImpact,
  type PauseResponse,
} from "@/chores/api";
import type { DateTimeFormats } from "@/invitations/format";
import { formatTaskDate, noMembers } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

export interface ChoreRepeatsProps {
  readonly choreId: string;
  readonly schedule: ChoreSchedule;
  readonly today: string;
  readonly manage: boolean;
  /** Names by membership id ("" for a departed member's empty place). */
  readonly memberNames: Readonly<Record<string, string>>;
  readonly formats: DateTimeFormats;
}

/** The next dates with whose turn each is, as text. */
export function NextDates({
  next,
  nameOf,
  formats,
}: {
  readonly next: readonly ChoreNextDate[];
  readonly nameOf: (id: string | null) => string;
  readonly formats: Pick<DateTimeFormats, "dateFormat">;
}) {
  const t = useTranslations("Chores");
  if (next.length === 0) return <p className="text-body text-fg-muted">{t("noNextDates")}</p>;
  return (
    <ul className="flex flex-col gap-0.5 text-body text-fg" data-testid="chore-next-dates">
      {next.map((entry) => (
        <li key={entry.date}>
          {t("previewLine", {
            date: formatTaskDate(entry.date, formats),
            person:
              entry.assigneeIds.length === 0
                ? t("unassigned")
                : entry.assigneeIds.map(nameOf).join(", "),
          })}
        </li>
      ))}
    </ul>
  );
}

/**
 * A recurring chore's schedule (S20): the rule in words, who it is for (the rotation order with any
 * empty place left by a member who left), the next dates with whose turn each is, and pausing or
 * resuming for chore managers after a preview of what it removes.
 */
export function ChoreRepeats({
  choreId,
  schedule,
  today,
  manage,
  memberNames,
  formats,
}: ChoreRepeatsProps) {
  const t = useTranslations("Chores");
  const text = useRecurrenceText(formats.dateFormat);
  const texts = useChoreTexts(noMembers);
  const nameOf = (id: string | null) => memberNames[id ?? ""] ?? t("personFormer");
  const radio = useId();
  const { announce, region } = useAnnouncer();
  const [pausing, setPausing] = useState(false);
  const [until, setUntil] = useState<"date" | "resume">("date");
  const [date, setDate] = useState("");
  const [preview, setPreview] = useState<PauseImpact | null>(null);
  const rule = {
    frequency: schedule.frequency,
    interval: schedule.interval,
    weekdays: schedule.weekdays ? [...schedule.weekdays] : null,
    startsOn: schedule.startsOn,
    endsOn: schedule.endsOn,
    count: schedule.count,
  };
  const mutation = useChoreMutation(
    `chore:${choreId}:schedule`,
    (input: { paused: boolean; until: string | null; dryRun: boolean }) =>
      sendChoreRequest<PauseResponse>("PUT", `${CHORES_ENDPOINT}/${choreId}/paused`, {
        expectedScheduleRevision: schedule.revision,
        ...input,
      }),
    (result, input) => {
      if (input.dryRun) {
        setPreview(result.impact);
        return;
      }
      announce(input.paused ? t("announcePaused") : t("announceResumed"));
      setPausing(false);
      setPreview(null);
    },
    { refresh: (_, input) => !input.dryRun },
  );
  const pauseUntil = until === "date" ? date : null;
  const dateInvalid = until === "date" && (date === "" || date < today);

  return (
    <section aria-labelledby="chore-repeats-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="chore-repeats-heading" className="text-section-title font-semibold text-fg">
          {t("repeatsHeading")}
        </h2>
        <p className="text-body text-fg" data-testid="chore-rule">
          {text.rule(rule)}
        </p>
        <p className="text-body text-fg">
          {schedule.assignment === "rotating"
            ? t("assignmentRotatingSummary", {
                order: schedule.members.map(nameOf).join(", "),
              })
            : schedule.assignment === "fixed"
              ? t("assignmentFixedSummary", { members: schedule.members.map(nameOf).join(", ") })
              : t("assignmentNoneSummary")}
        </p>
        {schedule.needsReassignment ? (
          <p className="text-body font-semibold text-fg">{t("rotationNeedsRepair")}</p>
        ) : null}
        {schedule.ended ? (
          <p className="text-body text-fg">{t("choreEnded")}</p>
        ) : schedule.finished ? (
          <p className="text-body text-fg">{t("scheduleFinished")}</p>
        ) : schedule.paused ? (
          <p className="text-body font-medium text-fg" data-testid="chore-paused">
            {schedule.paused.until
              ? t("pausedUntil", { date: formatTaskDate(schedule.paused.until, formats) })
              : t("pausedIndefinitely")}
          </p>
        ) : null}
        {!schedule.ended ? (
          <>
            <h3 className="text-body font-semibold text-fg">{t("nextDatesHeading")}</h3>
            <NextDates next={schedule.next} nameOf={nameOf} formats={formats} />
          </>
        ) : null}
        {manage && !schedule.ended && !schedule.finished ? (
          schedule.paused ? (
            <div>
              <Button
                variant="secondary"
                loading={mutation.busy}
                onClick={() => {
                  mutation.mutate({ paused: false, until: null, dryRun: false });
                }}
                data-testid="chore-resume"
              >
                {t("resume")}
              </Button>
            </div>
          ) : !pausing ? (
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  setPausing(true);
                  setPreview(null);
                  mutation.reset();
                }}
                data-testid="chore-pause-open"
              >
                {t("pause")}
              </Button>
            </div>
          ) : (
            <fieldset className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
              <legend className="sr-only">{t("pause")}</legend>
              <p className="text-helper text-fg-muted">{t("pauseHelp")}</p>
              <RadioOption
                name={radio}
                value="date"
                label={t("pauseUntilDate")}
                checked={until === "date"}
                onChange={() => {
                  setUntil("date");
                  setPreview(null);
                }}
              />
              {until === "date" ? (
                <TextField
                  type="date"
                  label={t("pauseLastDay")}
                  value={date}
                  min={today}
                  onChange={(event) => {
                    setDate(event.target.value);
                    setPreview(null);
                  }}
                  className="ms-8 max-w-60"
                  data-testid="chore-pause-until"
                />
              ) : null}
              <RadioOption
                name={radio}
                value="resume"
                label={t("pauseIndefinitely")}
                checked={until === "resume"}
                onChange={() => {
                  setUntil("resume");
                  setPreview(null);
                }}
              />
              {preview ? (
                <div
                  className="rounded-card border border-line bg-surface-sunken p-3"
                  aria-live="polite"
                >
                  <p className="text-body text-fg">
                    {t("pauseImpact", { removed: preview.removed, kept: preview.kept })}
                  </p>
                  <NextDates next={preview.next} nameOf={nameOf} formats={formats} />
                </div>
              ) : null}
              {mutation.error ? (
                <FormAlert tone="error" announce>
                  {texts.failure(mutation.error.failure)}
                </FormAlert>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {preview ? (
                  <Button
                    loading={mutation.busy}
                    onClick={() => {
                      mutation.mutate({ paused: true, until: pauseUntil, dryRun: false });
                    }}
                    data-testid="chore-pause-confirm"
                  >
                    {t("pauseConfirm")}
                  </Button>
                ) : (
                  <Button
                    loading={mutation.busy}
                    disabled={dateInvalid}
                    onClick={() => {
                      mutation.mutate({ paused: true, until: pauseUntil, dryRun: true });
                    }}
                    data-testid="chore-pause-preview"
                  >
                    {t("preview")}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPausing(false);
                  }}
                >
                  {t("cancel")}
                </Button>
              </div>
            </fieldset>
          )
        ) : null}
      </HydrationGate>
    </section>
  );
}
