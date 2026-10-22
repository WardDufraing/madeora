"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { VACATION_LIMITS } from "@madeora/domain/vacations";

import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import type { DateTimeFormats } from "@/invitations/format";
import { addDays } from "@/tasks/calendar";
import { memberNames, type MemberOption } from "@/tasks/format";
import {
  VACATION_PARTICIPANTS_ENDPOINT,
  VACATION_PROPOSALS_ENDPOINT,
  VACATIONS_ENDPOINT,
  type VacationDetail,
  type VacationPerson,
} from "@/vacations/api";
import { rangesText } from "@/vacations/format";
import { vacationNameSchema } from "@/vacations/schema";

import { ChangeDialog } from "./change-dialog";
import { datesSchema, useVacationFieldMessage } from "./stay-fields";

type Formats = Pick<DateTimeFormats, "dateFormat">;

/**
 * The vacation's own actions by role (S22): rename, reminder, end early, cancel, the Home-wide chore
 * pause, and adding or inviting people. The page passes only what the database says the viewer may
 * do; the database checks it again.
 */
export function VacationActions({
  vacation,
  members,
  formats,
}: {
  readonly vacation: VacationDetail;
  readonly members: readonly MemberOption[];
  readonly formats: Formats;
}) {
  const t = useTranslations("Vacations");
  const names = memberNames(members);
  const message = useVacationFieldMessage();
  const url = `${VACATIONS_ENDPOINT}/${vacation.id}`;
  const scope = `vacation:${vacation.id}`;
  const revision = { expectedRevision: vacation.revision };
  const [name, setName] = useState(vacation.name ?? "");
  const [nameError, setNameError] = useState<string | undefined>();
  const [days, setDays] = useState(
    vacation.reminderDays === null ? "" : String(vacation.reminderDays),
  );
  const [daysError, setDaysError] = useState<string | undefined>();
  const lastDay = vacation.endsOn > vacation.today ? addDays(vacation.endsOn, -1) : vacation.today;
  const earliestEnd =
    vacation.startsOn > addDays(vacation.today, -1)
      ? vacation.startsOn
      : addDays(vacation.today, -1);
  const [endsOn, setEndsOn] = useState(lastDay);
  const common = { scope, url, method: "PATCH" as const, names, formats };
  const confirmed = vacation.homePause.confirmed !== null;

  return (
    <HydrationGate>
      <div className="flex flex-wrap gap-2" data-testid="vacation-actions">
        {vacation.can.rename ? (
          <ChangeDialog
            {...common}
            label={t("rename")}
            title={t("renameTitle")}
            description={t("renameBody")}
            confirmLabel={t("save")}
            announcement={t("announceRenamed")}
            previewed={false}
            onOpen={() => {
              setName(vacation.name ?? "");
              setNameError(undefined);
            }}
            fields={
              <TextField
                label={t("fieldName")}
                description={t("fieldNameHelp")}
                value={name}
                maxLength={VACATION_LIMITS.name * 2}
                error={nameError}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            }
            build={() => {
              const parsed = vacationNameSchema.safeParse(name);
              if (!parsed.success) {
                setNameError(message(parsed.error.issues[0]));
                return null;
              }
              setNameError(undefined);
              return { action: "rename", ...revision, name };
            }}
            testId="vacation-rename"
          />
        ) : null}
        {vacation.can.reminder ? (
          <ChangeDialog
            {...common}
            label={t("reminder")}
            title={t("reminderTitle")}
            description={t("reminderBody")}
            confirmLabel={t("save")}
            announcement={t("announceReminder")}
            previewed={false}
            fields={
              <TextField
                type="number"
                inputMode="numeric"
                min={1}
                max={VACATION_LIMITS.reminderDays}
                label={t("fieldReminder")}
                description={t("fieldReminderHelp")}
                value={days}
                error={daysError}
                onChange={(event) => {
                  setDays(event.target.value);
                }}
              />
            }
            build={() => {
              if (days === "") return { action: "reminder", ...revision, reminderDays: null };
              const value = Number(days);
              if (!Number.isInteger(value) || value < 1 || value > VACATION_LIMITS.reminderDays) {
                setDaysError(t("errorReminderRange"));
                return null;
              }
              setDaysError(undefined);
              return { action: "reminder", ...revision, reminderDays: value };
            }}
            testId="vacation-reminder"
          />
        ) : null}
        {vacation.can.pause && vacation.homePause.available.length > 0 ? (
          <ChangeDialog
            {...common}
            variant="primary"
            label={confirmed ? t("pauseMore") : t("pause")}
            title={t("pauseTitle")}
            description={t("pauseBody", {
              dates: rangesText(vacation.homePause.available, formats),
            })}
            confirmLabel={t("pauseConfirm")}
            announcement={t("announcePaused")}
            build={() => ({ action: "pause", ...revision })}
            testId="vacation-pause"
          />
        ) : null}
        {vacation.can.pause && confirmed ? (
          <ChangeDialog
            {...common}
            label={t("unpause")}
            title={t("unpauseTitle")}
            description={t("unpauseBody")}
            confirmLabel={t("unpauseConfirm")}
            announcement={t("announceUnpaused")}
            build={() => ({ action: "unpause", ...revision })}
            testId="vacation-unpause"
          />
        ) : null}
        {vacation.can.shorten && lastDay >= earliestEnd ? (
          <ChangeDialog
            {...common}
            label={t("shorten")}
            title={t("shortenTitle")}
            description={t("shortenBody")}
            confirmLabel={t("shortenConfirm")}
            announcement={t("announceShortened")}
            onOpen={() => {
              setEndsOn(lastDay);
            }}
            fields={
              <TextField
                type="date"
                label={t("fieldNewEnd")}
                min={earliestEnd}
                max={lastDay}
                value={endsOn}
                onChange={(event) => {
                  setEndsOn(event.target.value);
                }}
              />
            }
            build={() => (endsOn === "" ? null : { action: "shorten", ...revision, endsOn })}
            testId="vacation-shorten"
          />
        ) : null}
        {vacation.can.cancel ? (
          <ChangeDialog
            {...common}
            variant="destructive"
            label={t("cancelVacation")}
            title={t("cancelTitle")}
            description={t("cancelBody")}
            confirmLabel={t("cancelConfirm")}
            announcement={t("announceCancelled")}
            build={() => ({ action: "cancel", ...revision })}
            testId="vacation-cancel"
          />
        ) : null}
      </div>
    </HydrationGate>
  );
}

/**
 * Adding people (S22): a chore manager adds members directly with their own dates; the creator
 * invites them (they accept or decline, and an invitation must start after today).
 */
export function AddParticipants({
  vacation,
  members,
  formats,
}: {
  readonly vacation: VacationDetail;
  readonly members: readonly MemberOption[];
  readonly formats: Formats;
}) {
  const t = useTranslations("Vacations");
  const names = memberNames(members);
  const texts = useChoreTexts(names);
  const message = useVacationFieldMessage();
  const taken = new Set(
    vacation.people
      .filter((person) => person.status === "pending" || person.status === "accepted")
      .map((person) => person.member?.member),
  );
  const free = members.filter((member) => !taken.has(member.id));
  const defaultStart =
    vacation.startsOn > vacation.today ? vacation.startsOn : addDays(vacation.today, 1);
  const [memberId, setMemberId] = useState("");
  const [startsOn, setStartsOn] = useState(defaultStart);
  const [endsOn, setEndsOn] = useState(vacation.endsOn);
  const [error, setError] = useState<string | undefined>();
  if (free.length === 0) return null;
  return (
    <HydrationGate>
      <ChangeDialog
        scope={`vacation:${vacation.id}`}
        method="POST"
        url={`${VACATIONS_ENDPOINT}/${vacation.id}/participants`}
        names={names}
        formats={formats}
        label={vacation.can.addDirectly ? t("addPeople") : t("invitePeople")}
        title={vacation.can.addDirectly ? t("addPeopleTitle") : t("invitePeopleTitle")}
        description={vacation.can.addDirectly ? t("addPeopleBody") : t("invitePeopleBody")}
        confirmLabel={vacation.can.addDirectly ? t("addConfirm") : t("inviteConfirm")}
        announcement={vacation.can.addDirectly ? t("announceAdded") : t("announceInvited")}
        onOpen={() => {
          setMemberId("");
          setStartsOn(defaultStart);
          setEndsOn(vacation.endsOn);
          setError(undefined);
        }}
        fields={
          <>
            <SelectField
              label={t("fieldMember")}
              options={[
                { value: "", label: t("pickMember") },
                ...free.map((member) => ({
                  value: member.id,
                  label: member.isSelf ? t("you") : texts.member(member.id),
                })),
              ]}
              value={memberId}
              onChange={(event) => {
                setMemberId(event.target.value);
              }}
            />
            <TextField
              type="date"
              label={t("fieldStartsOn")}
              value={startsOn}
              onChange={(event) => {
                setStartsOn(event.target.value);
              }}
            />
            <TextField
              type="date"
              label={t("fieldEndsOn")}
              value={endsOn}
              error={error}
              onChange={(event) => {
                setEndsOn(event.target.value);
              }}
            />
          </>
        }
        build={() => {
          const dates = datesSchema.safeParse({ startsOn, endsOn });
          if (memberId === "") {
            setError(t("errorMemberRequired"));
            return null;
          }
          if (!dates.success) {
            setError(message(dates.error.issues[0]));
            return null;
          }
          setError(undefined);
          return {
            expectedRevision: vacation.revision,
            people: [{ memberId, startsOn, endsOn }],
          };
        }}
        testId="vacation-add"
      />
    </HydrationGate>
  );
}

/**
 * The actions on one participation (S22), as the database allows them: answer an invitation,
 * withdraw, remove, withdraw an invitation, change or propose dates, withdraw one's own proposal.
 */
export function ParticipantActions({
  person,
  label,
  members,
  formats,
}: {
  readonly person: VacationPerson;
  /** The person's shown name, for accessible names. */
  readonly label: string;
  readonly members: readonly MemberOption[];
  readonly formats: Formats;
}) {
  const t = useTranslations("Vacations");
  const names = memberNames(members);
  const message = useVacationFieldMessage();
  const [startsOn, setStartsOn] = useState(person.startsOn);
  const [endsOn, setEndsOn] = useState(person.endsOn);
  const [error, setError] = useState<string | undefined>();
  const url = `${VACATION_PARTICIPANTS_ENDPOINT}/${person.id}`;
  const scope = `vacation-participant:${person.id}`;
  const revision = { expectedRevision: person.revision };
  const common = { scope, url, method: "PATCH" as const, names, formats };
  const dates = (action: "change_dates" | "propose_dates") => ({
    onOpen: () => {
      setStartsOn(person.startsOn);
      setEndsOn(person.endsOn);
      setError(undefined);
    },
    fields: (
      <>
        <TextField
          type="date"
          label={t("fieldStartsOn")}
          value={startsOn}
          onChange={(event) => {
            setStartsOn(event.target.value);
          }}
        />
        <TextField
          type="date"
          label={t("fieldEndsOn")}
          value={endsOn}
          error={error}
          onChange={(event) => {
            setEndsOn(event.target.value);
          }}
        />
      </>
    ),
    build: () => {
      const parsed = datesSchema.safeParse({ startsOn, endsOn });
      if (!parsed.success) {
        setError(message(parsed.error.issues[0]));
        return null;
      }
      setError(undefined);
      return { action, ...revision, startsOn, endsOn };
    },
  });
  const simple = (
    action: "withdraw" | "remove" | "cancel_invitation",
    key: "withdraw" | "remove" | "cancelInvitation",
    variant: "secondary" | "destructive" = "secondary",
  ) => (
    <ChangeDialog
      {...common}
      variant={variant}
      label={t(`${key}Action`)}
      ariaLabel={t(`${key}Named`, { name: label })}
      title={t(`${key}Title`)}
      description={t(`${key}Body`, { name: label })}
      confirmLabel={t(`${key}Confirm`)}
      announcement={t(`${key}Announce`)}
      build={() => ({ action, ...revision })}
      testId={`participant-${key}`}
    />
  );

  return (
    <HydrationGate>
      <div className="flex flex-wrap gap-2">
        {person.can.answer ? (
          <ChangeDialog
            {...common}
            variant="primary"
            label={t("accept")}
            ariaLabel={t("acceptNamed", { name: label })}
            title={t("acceptTitle")}
            description={t("acceptBody")}
            confirmLabel={t("confirmAccept")}
            announcement={t("announceAccepted")}
            build={() => ({ action: "accept", ...revision })}
            testId="participant-accept"
          />
        ) : null}
        {person.can.answer ? (
          <ChangeDialog
            {...common}
            label={t("decline")}
            ariaLabel={t("declineNamed", { name: label })}
            title={t("declineTitle")}
            description={t("declineBody")}
            confirmLabel={t("decline")}
            announcement={t("announceDeclined")}
            previewed={false}
            build={() => ({ action: "decline", ...revision })}
            testId="participant-decline"
          />
        ) : null}
        {person.can.withdraw ? simple("withdraw", "withdraw") : null}
        {person.can.changeDates ? (
          <ChangeDialog
            {...common}
            label={t("changeDates")}
            ariaLabel={t("changeDatesNamed", { name: label })}
            title={t("changeDatesTitle")}
            description={t("changeDatesBody", { name: label })}
            confirmLabel={t("save")}
            announcement={t("announceDatesChanged")}
            {...dates("change_dates")}
            testId="participant-dates"
          />
        ) : null}
        {person.can.proposeDates ? (
          <ChangeDialog
            {...common}
            label={t("proposeDates")}
            ariaLabel={t("proposeDatesNamed", { name: label })}
            title={t("proposeDatesTitle")}
            description={t("proposeDatesBody", { name: label })}
            confirmLabel={t("proposeConfirm")}
            announcement={t("announceProposed")}
            {...dates("propose_dates")}
            testId="participant-propose"
          />
        ) : null}
        {person.proposal?.mine ? (
          <ChangeDialog
            scope={`vacation-proposal:${person.proposal.id}`}
            url={`${VACATION_PROPOSALS_ENDPOINT}/${person.proposal.id}`}
            method="PATCH"
            names={names}
            formats={formats}
            label={t("withdrawProposal")}
            ariaLabel={t("withdrawProposalNamed", { name: label })}
            title={t("withdrawProposalTitle")}
            description={t("withdrawProposalBody")}
            confirmLabel={t("withdrawProposal")}
            announcement={t("announceProposalWithdrawn")}
            previewed={false}
            build={() => ({ action: "withdraw" })}
            testId="participant-proposal-withdraw"
          />
        ) : null}
        {person.can.cancelInvitation && !person.can.remove
          ? simple("cancel_invitation", "cancelInvitation")
          : null}
        {person.can.remove ? simple("remove", "remove", "destructive") : null}
      </div>
    </HydrationGate>
  );
}
