"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { PointsChangeNote } from "@/components/points/points-change";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useNow } from "@/components/ui/use-now";
import {
  CHORE_OCCURRENCES_ENDPOINT,
  sendChoreRequest,
  type ChoreOccurrenceDetail,
  type RevisionResponse,
} from "@/chores/api";
import { instantFromZoned, zonedParts } from "@/chores/format";
import { CHORE_LIMITS, normalizeShortText } from "@/chores/schema";
import type { DateTimeFormats } from "@/invitations/format";
import { memberNames, type MemberOption } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

export interface ChoreCorrectProps {
  readonly occurrence: ChoreOccurrenceDetail;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
  /** Called after a correction was recorded. */
  readonly onCorrected: (message: string) => void;
}

/**
 * Correcting a completed record (S20, chore managers; spec "Confirmed correction and reversal of
 * completed chores"): who actually did it, when (a date and time in the viewer's timezone: a time
 * skipped by daylight saving is refused, never guessed), and the note, with an optional reason.
 * What was recorded before stays in the occurrence's events. The points change it makes is shown
 * before saving (S23).
 */
export function ChoreCorrect({ occurrence, members, formats, onCorrected }: ChoreCorrectProps) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(memberNames(members));
  const completion = occurrence.completion;
  const initialWhen = completion ? zonedParts(completion.at, formats.timeZone) : null;
  const initialContributor = completion?.contributor?.member ?? "";
  const [open, setOpen] = useState(false);
  const [contributor, setContributor] = useState(initialContributor);
  const [date, setDate] = useState(initialWhen?.date ?? "");
  const [time, setTime] = useState(initialWhen?.time ?? "");
  const [note, setNote] = useState(completion?.note ?? "");
  const [reason, setReason] = useState("");
  const now = useNow();
  const mutation = useChoreMutation(
    `chore-occurrence:${occurrence.id}`,
    (input: object) =>
      sendChoreRequest<RevisionResponse>(
        "PUT",
        `${CHORE_OCCURRENCES_ENDPOINT}/${occurrence.id}/completion-record`,
        input,
      ),
    (result) => {
      setOpen(false);
      onCorrected(result.outcome === "unchanged" ? t("announceUnchanged") : t("announceCorrected"));
    },
  );
  if (!completion) return null;
  const close = () => {
    setOpen(false);
  };
  const instant = instantFromZoned(date, time, formats.timeZone);
  const timeChanged =
    initialWhen !== null && (date !== initialWhen.date || time !== initialWhen.time);
  // To the minute; the server refuses anything more than a few minutes ahead anyway.
  const future = instant !== null && now !== null && Date.parse(instant) > now + 60_000;
  const timeError = timeChanged
    ? instant === null
      ? t("fieldCorrectTimeInvalid")
      : future
        ? t("fieldCorrectTimeFuture")
        : undefined
    : undefined;
  const noteText = normalizeShortText(note);
  const reasonText = normalizeShortText(reason);
  const noteTooLong = noteText !== null && noteText.length > CHORE_LIMITS.note;
  const reasonTooLong = reasonText !== null && reasonText.length > CHORE_LIMITS.reason;

  return (
    <>
      <div>
        <Button
          variant="secondary"
          onClick={() => {
            setContributor(initialContributor);
            setDate(initialWhen?.date ?? "");
            setTime(initialWhen?.time ?? "");
            setNote(completion.note ?? "");
            setReason("");
            mutation.reset();
            setOpen(true);
          }}
          data-testid="chore-correct-open"
        >
          {t("correct")}
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={close}
        title={t("correctTitle")}
        description={t("correctBody")}
        closeLabel={t("close")}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {t("cancel")}
            </Button>
            <Button
              loading={mutation.busy}
              disabled={timeError !== undefined || noteTooLong || reasonTooLong}
              onClick={() => {
                mutation.mutate({
                  expectedRevision: occurrence.revision,
                  ...(contributor && contributor !== initialContributor ? { contributor } : {}),
                  ...(timeChanged && instant ? { completedAt: instant } : {}),
                  ...(noteText !== (completion.note ?? null) ? { note: noteText } : {}),
                  reason: reasonText,
                });
              }}
              data-testid="chore-correct-confirm"
            >
              {t("correctSave")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <SelectField
            label={t("fieldContributor")}
            value={contributor}
            onChange={(event) => {
              setContributor(event.target.value);
            }}
            options={[
              ...(initialContributor === ""
                ? [{ value: "", label: texts.person(completion.contributor) }]
                : []),
              ...members.map((member) => ({
                value: member.id,
                label: member.isSelf ? t("personYou") : (member.name ?? t("personUnnamed")),
              })),
            ]}
            data-testid="chore-correct-contributor"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              type="date"
              label={t("fieldCorrectDate")}
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
              }}
              error={timeError}
            />
            <TextField
              type="time"
              label={t("fieldCorrectTime")}
              description={t("fieldCorrectTimeHelp", { zone: formats.timeZone })}
              value={time}
              onChange={(event) => {
                setTime(event.target.value);
              }}
            />
          </div>
          <TextArea
            label={t("fieldNote")}
            description={t("fieldNoteHelp", { max: CHORE_LIMITS.note })}
            rows={2}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            error={noteTooLong ? t("fieldTooLong") : undefined}
          />
          <TextArea
            label={t("fieldCorrectReason")}
            description={t("fieldReasonHelp", { max: CHORE_LIMITS.reason })}
            rows={2}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            error={reasonTooLong ? t("fieldTooLong") : undefined}
          />
          <PointsChangeNote
            occurrenceId={occurrence.id}
            request={
              open
                ? {
                    action: "correct",
                    contributor:
                      contributor && contributor !== initialContributor ? contributor : null,
                    completedAt: timeChanged && instant && !future ? instant : null,
                  }
                : null
            }
            names={memberNames(members)}
          />
          {mutation.error ? (
            <FormAlert tone="error" announce>
              {texts.failure(mutation.error.failure, mutation.error.detail)}
            </FormAlert>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
