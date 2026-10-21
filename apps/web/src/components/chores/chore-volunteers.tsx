"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_OCCURRENCES_ENDPOINT,
  CHORE_VOLUNTEERS_ENDPOINT,
  sendChoreRequest,
  type ChoreVolunteerState,
  type CorrectionPreview,
  type VolunteerInvitationStatus,
  type VolunteerOffer,
  type VolunteerPreview,
  type VolunteerRequestStatus,
  type VolunteerRequestView,
} from "@/chores/api";
import { choresPath } from "@/chores/format";
import { CHORE_LIMITS, normalizeShortText } from "@/chores/schema";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import { formatTaskDate, memberNames, noMembers, type MemberOption } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

const requestStatusKey = {
  open: "volunteerRequestOpen",
  accepted: "volunteerRequestAccepted",
  cancelled: "volunteerRequestCancelled",
  resolved: "volunteerRequestResolved",
  closed: "volunteerRequestClosed",
  expired: "volunteerRequestExpired",
} as const satisfies Record<VolunteerRequestStatus, string>;

const invitationStatusKey = {
  pending: "volunteerInvitePending",
  accepted: "volunteerInviteAccepted",
  declined: "volunteerInviteDeclined",
  withdrawn: "volunteerInviteWithdrawn",
  expired: "volunteerInviteExpired",
  closed: "volunteerInviteClosed",
} as const satisfies Record<VolunteerInvitationStatus, string>;

type Answer = "accept" | "decline";

/** Accept or decline one volunteer invitation; the database decides who was first. */
function AnswerButtons({
  requestId,
  title,
  onAnswered,
}: {
  readonly requestId: string;
  readonly title: string;
  readonly onAnswered: (answer: Answer) => void;
}) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const mutation = useChoreMutation(
    `chore-volunteer:${requestId}`,
    (action: Answer) =>
      sendChoreRequest("PATCH", `${CHORE_VOLUNTEERS_ENDPOINT}/${requestId}`, { action }),
    (_result, action) => {
      onAnswered(action);
    },
    { refreshOnError: (failure) => failure === "notOpen" || failure === "deadlinePassed" },
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          loading={mutation.busy && mutation.variables === "accept"}
          disabled={mutation.busy}
          onClick={() => {
            mutation.mutate("accept");
          }}
          aria-label={t("volunteerAcceptNamed", { title })}
          data-testid="volunteer-accept"
        >
          {t("volunteerAccept")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={mutation.busy && mutation.variables === "decline"}
          disabled={mutation.busy}
          onClick={() => {
            mutation.mutate("decline");
          }}
          aria-label={t("volunteerDeclineNamed", { title })}
          data-testid="volunteer-decline"
        >
          {t("volunteerDecline")}
        </Button>
      </div>
      {mutation.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(mutation.error.failure, mutation.error.detail)}
        </FormAlert>
      ) : null}
    </div>
  );
}

/**
 * The viewer's open volunteer invitations in a Home (S21; spec "Targeted volunteer requests"):
 * what the chore is (title, due date, instructions, checklist, estimate) and until when the
 * request is open, with accept or decline. Never the roster, others' answers or a reason.
 */
export function VolunteerOffers({
  homeId,
  offers,
  formats,
}: {
  readonly homeId: string;
  readonly offers: readonly VolunteerOffer[];
  readonly formats: DateTimeFormats;
}) {
  const t = useTranslations("Chores");
  const { announce, region } = useAnnouncer();
  return (
    <section
      aria-labelledby="volunteer-offers-heading"
      className="flex flex-col gap-3"
      data-testid="volunteer-offers"
    >
      {region}
      <h2 id="volunteer-offers-heading" className="text-section-title font-semibold text-fg">
        {t("volunteerOffersHeading")}
      </h2>
      <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
        {offers.map((offer) => (
          <li
            key={offer.requestId}
            className="flex flex-col gap-2 p-3"
            data-testid="volunteer-offer"
          >
            <Link
              href={`${choresPath(homeId)}/${offer.occurrenceId}`}
              className="text-body font-semibold text-fg underline-offset-2 hover:underline"
            >
              <bdi>{offer.title}</bdi>
            </Link>
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-helper text-fg-muted">
              <span>{t("dueOn", { date: formatTaskDate(offer.dueDate, formats) })}</span>
              <span>
                {offer.minutes === null ? t("noEstimate") : t("minutes", { count: offer.minutes })}
              </span>
              <span>
                {t("volunteerOpenUntil", { date: formatDateTime(offer.deadline, formats) })}
              </span>
            </p>
            {offer.instructions ? (
              <p className="whitespace-pre-wrap break-words text-body text-fg">
                {offer.instructions}
              </p>
            ) : null}
            {offer.steps.length > 0 ? (
              <ul className="ms-5 list-disc text-body text-fg">
                {offer.steps.map((step, index) => (
                  <li key={index} className="break-words">
                    <bdi>{step.label}</bdi>
                  </li>
                ))}
              </ul>
            ) : null}
            <HydrationGate>
              <AnswerButtons
                requestId={offer.requestId}
                title={offer.title}
                onAnswered={(answer) => {
                  announce(
                    answer === "accept"
                      ? t("announceVolunteerAccepted")
                      : t("announceVolunteerDeclined"),
                  );
                }}
              />
            </HydrationGate>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface ChoreVolunteerPanelProps {
  readonly occurrenceId: string;
  /** The occurrence's revision the person sees: a request or correction on anything newer is refused. */
  readonly revision: number;
  readonly title: string;
  readonly state: ChoreVolunteerState;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
}

/**
 * The volunteer side of one occurrence (S21). Everyone sees Awaiting volunteer while a request is
 * open. An invitee sees their own invitation and answers it. A chore manager asks 1-20 members of
 * an occurrence in Needs assignment review, previewing until when the request is open; follows the
 * roster; withdraws single invitations, invites more members or cancels; and corrects an accepted
 * volunteer's assignment with a reason, back to review or to another member, after a preview.
 */
export function ChoreVolunteerPanel({
  occurrenceId,
  revision,
  title,
  state,
  members,
  formats,
}: ChoreVolunteerPanelProps) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(memberNames(members));
  const { announce, region } = useAnnouncer();
  const open = state.requests.find((request) => request.status === "open") ?? null;
  const past = state.requests.filter((request) => request.status !== "open");
  const ownInvite = open?.invitations.find((invitation) => invitation.canAnswer) ?? null;
  if (
    !state.inReview &&
    !state.awaitingVolunteer &&
    !state.canCorrect &&
    state.requests.length === 0
  ) {
    return null;
  }

  return (
    <section
      aria-labelledby="chore-volunteers-heading"
      className="flex flex-col gap-3"
      data-testid="chore-volunteers"
    >
      {region}
      <h2 id="chore-volunteers-heading" className="text-section-title font-semibold text-fg">
        {t("volunteersHeading")}
      </h2>
      {state.awaitingVolunteer ? (
        <p className="text-body font-semibold text-fg" data-testid="chore-awaiting-volunteer">
          {t("awaitingVolunteer")}{" "}
          <span className="font-normal text-fg-muted">
            {t("volunteerOpenUntil", { date: formatDateTime(state.deadline, formats) })}
          </span>
        </p>
      ) : state.inReview ? (
        <p className="text-body text-fg-muted">{t("volunteerInReview")}</p>
      ) : null}
      <HydrationGate>
        {ownInvite && open ? (
          <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3">
            <p className="text-body text-fg">{t("volunteerYouAreInvited")}</p>
            <AnswerButtons
              requestId={open.id}
              title={title}
              onAnswered={(answer) => {
                announce(
                  answer === "accept"
                    ? t("announceVolunteerAccepted")
                    : t("announceVolunteerDeclined"),
                );
              }}
            />
          </div>
        ) : null}
        {open?.canChange ? (
          <VolunteerRoster
            request={open}
            members={members}
            formats={formats}
            onChanged={announce}
          />
        ) : null}
        {state.canRequest ? (
          <VolunteerRequestForm
            occurrenceId={occurrenceId}
            revision={revision}
            members={members}
            formats={formats}
            onSent={() => {
              announce(t("announceVolunteerSent"));
            }}
          />
        ) : null}
        {state.canCorrect && state.volunteer ? (
          <VolunteerCorrection
            occurrenceId={occurrenceId}
            revision={revision}
            volunteer={texts.person(state.volunteer)}
            volunteerId={state.volunteer.member}
            members={members}
            onCorrected={() => {
              announce(t("announceVolunteerCorrected"));
            }}
          />
        ) : null}
      </HydrationGate>
      {past.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-body font-semibold text-fg">{t("volunteerPastRequests")}</h3>
          <ul
            className="flex flex-col gap-1 text-helper text-fg-muted"
            data-testid="volunteer-past"
          >
            {past.map((request) => (
              <li key={request.id}>
                {t("volunteerPastLine", {
                  date: formatDateTime(request.createdAt, formats),
                  status: t(requestStatusKey[request.status]),
                })}
                {request.acceptedBy
                  ? ` ${t("volunteerAcceptedBy", { person: texts.person(request.acceptedBy) })}`
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

type RosterChange =
  | { readonly action: "cancel" }
  | { readonly action: "withdraw" | "add"; readonly memberIds: readonly string[] };

/** A chore manager's view of an open request: who was asked and how they answered. */
function VolunteerRoster({
  request,
  members,
  formats,
  onChanged,
}: {
  readonly request: VolunteerRequestView;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
  readonly onChanged: (message: string) => void;
}) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(memberNames(members));
  const [adding, setAdding] = useState<readonly string[]>([]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const mutation = useChoreMutation(
    `chore-volunteer:${request.id}`,
    (change: RosterChange) =>
      sendChoreRequest<{ readonly closed?: boolean }>(
        "PATCH",
        `${CHORE_VOLUNTEERS_ENDPOINT}/${request.id}`,
        change,
      ),
    (result, change) => {
      setConfirmCancel(false);
      setAdding([]);
      onChanged(
        change.action === "cancel"
          ? t("announceVolunteerCancelled")
          : change.action === "add"
            ? t("announceVolunteerAdded")
            : result.closed
              ? t("announceVolunteerClosed")
              : t("announceVolunteerWithdrawn"),
      );
    },
    { refreshOnError: (failure) => failure === "notOpen" },
  );
  const invited = new Set(
    request.invitations.flatMap((invitation) =>
      invitation.member?.member ? [invitation.member.member] : [],
    ),
  );
  const addable = members.filter((member) => !invited.has(member.id));
  const room = CHORE_LIMITS.recipients - invited.size;

  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3">
      <h3 className="text-body font-semibold text-fg">{t("volunteerRosterHeading")}</h3>
      <ul className="flex flex-col divide-y divide-line" data-testid="volunteer-roster">
        {request.invitations.map((invitation, index) => {
          const name = texts.person(invitation.member);
          return (
            <li
              key={invitation.member?.member ?? `former-${String(index)}`}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="volunteer-invitation"
            >
              <span className="text-body text-fg">
                <bdi>{name}</bdi>
                <span className="ms-2 text-helper font-semibold">
                  {t(invitationStatusKey[invitation.status])}
                </span>
                <span className="ms-2 text-helper text-fg-muted">
                  {formatDateTime(invitation.respondedAt ?? invitation.invitedAt, formats)}
                </span>
              </span>
              {invitation.status === "pending" && invitation.member?.member ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={mutation.busy}
                  onClick={() => {
                    const memberId = invitation.member?.member;
                    if (memberId) mutation.mutate({ action: "withdraw", memberIds: [memberId] });
                  }}
                  aria-label={t("volunteerWithdrawNamed", { person: name })}
                  data-testid="volunteer-withdraw"
                >
                  {t("volunteerWithdraw")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {addable.length > 0 && room > 0 ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-body font-medium text-fg">{t("volunteerAddHeading")}</legend>
          {addable.map((member) => (
            <Checkbox
              key={member.id}
              label={texts.member(member.id)}
              checked={adding.includes(member.id)}
              onChange={(event) => {
                setAdding((current) =>
                  event.target.checked
                    ? [...current, member.id]
                    : current.filter((id) => id !== member.id),
                );
              }}
            />
          ))}
          <div>
            <Button
              size="sm"
              variant="secondary"
              disabled={adding.length === 0 || adding.length > room || mutation.busy}
              onClick={() => {
                mutation.mutate({ action: "add", memberIds: adding });
              }}
              data-testid="volunteer-add"
            >
              {t("volunteerAdd")}
            </Button>
          </div>
        </fieldset>
      ) : null}
      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            mutation.reset();
            setConfirmCancel(true);
          }}
          data-testid="volunteer-cancel-open"
        >
          {t("volunteerCancel")}
        </Button>
      </div>
      {mutation.error && !confirmCancel ? (
        <FormAlert tone="error" announce>
          {texts.failure(mutation.error.failure, mutation.error.detail)}
        </FormAlert>
      ) : null}
      <Dialog
        open={confirmCancel}
        onClose={() => {
          setConfirmCancel(false);
        }}
        title={t("volunteerCancelTitle")}
        description={t("volunteerCancelBody")}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmCancel(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              loading={mutation.busy}
              onClick={() => {
                mutation.mutate({ action: "cancel" });
              }}
              data-testid="volunteer-cancel-confirm"
            >
              {t("volunteerCancel")}
            </Button>
          </>
        }
      >
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure, mutation.error.detail)}
          </FormAlert>
        ) : null}
      </Dialog>
    </div>
  );
}

/** Asking members to volunteer: choose 1-20, preview until when it is open, then send. */
function VolunteerRequestForm({
  occurrenceId,
  revision,
  members,
  formats,
  onSent,
}: {
  readonly occurrenceId: string;
  readonly revision: number;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
  readonly onSent: () => void;
}) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(memberNames(members));
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [preview, setPreview] = useState<VolunteerPreview | null>(null);
  const [chooseError, setChooseError] = useState(false);
  const mutation = useChoreMutation(
    `chore-occurrence:${occurrenceId}`,
    (input: { readonly dryRun: boolean }) =>
      sendChoreRequest<VolunteerPreview>(
        "POST",
        `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}/volunteers`,
        { id: requestId, expectedRevision: revision, memberIds: chosen, dryRun: input.dryRun },
      ),
    (result, input) => {
      if (input.dryRun) {
        setPreview(result);
        return;
      }
      setOpen(false);
      setPreview(null);
      setChosen([]);
      setRequestId(crypto.randomUUID());
      onSent();
    },
    { refresh: (_result, input) => !input.dryRun },
  );
  const close = () => {
    setOpen(false);
    setPreview(null);
  };

  return (
    <>
      <div>
        <Button
          onClick={() => {
            mutation.reset();
            setPreview(null);
            setChooseError(false);
            setOpen(true);
          }}
          data-testid="volunteer-request-open"
        >
          {t("volunteerRequest")}
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={close}
        title={t("volunteerRequestTitle")}
        description={t("volunteerRequestBody", { max: CHORE_LIMITS.recipients })}
        closeLabel={t("close")}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {t("cancel")}
            </Button>
            {preview ? (
              <Button
                loading={mutation.busy}
                onClick={() => {
                  mutation.mutate({ dryRun: false });
                }}
                data-testid="volunteer-request-send"
              >
                {t("volunteerSend")}
              </Button>
            ) : (
              <Button
                loading={mutation.busy}
                onClick={() => {
                  if (chosen.length === 0 || chosen.length > CHORE_LIMITS.recipients) {
                    setChooseError(true);
                    return;
                  }
                  mutation.mutate({ dryRun: true });
                }}
                data-testid="volunteer-request-preview"
              >
                {t("volunteerPreview")}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-1" disabled={preview !== null}>
            <legend className="text-body font-medium text-fg">{t("volunteerRecipients")}</legend>
            {members.map((member) => (
              <Checkbox
                key={member.id}
                label={texts.member(member.id)}
                checked={chosen.includes(member.id)}
                onChange={(event) => {
                  setChooseError(false);
                  setChosen((current) =>
                    event.target.checked
                      ? [...current, member.id]
                      : current.filter((id) => id !== member.id),
                  );
                }}
              />
            ))}
          </fieldset>
          {chooseError ? (
            <FormAlert tone="error" announce>
              {t("volunteerChooseError", { max: CHORE_LIMITS.recipients })}
            </FormAlert>
          ) : null}
          {preview?.deadline ? (
            <p className="text-body text-fg" role="status" data-testid="volunteer-request-deadline">
              {t("volunteerPreviewDeadline", {
                count: chosen.length,
                date: formatDateTime(preview.deadline, formats),
              })}
            </p>
          ) : null}
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

/** Correcting an accepted volunteer's assignment, with a reason and a preview (chore managers). */
function VolunteerCorrection({
  occurrenceId,
  revision,
  volunteer,
  volunteerId,
  members,
  onCorrected,
}: {
  readonly occurrenceId: string;
  readonly revision: number;
  readonly volunteer: string;
  readonly volunteerId: string | null;
  readonly members: readonly MemberOption[];
  readonly onCorrected: () => void;
}) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(memberNames(members));
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const [preview, setPreview] = useState<CorrectionPreview | null>(null);
  const reasonText = normalizeShortText(reason);
  const tooLong = reasonText !== null && reasonText.length > CHORE_LIMITS.reason;
  const mutation = useChoreMutation(
    `chore-occurrence:${occurrenceId}`,
    (input: { readonly dryRun: boolean; readonly reason: string }) =>
      sendChoreRequest<CorrectionPreview>(
        "POST",
        `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}/volunteer-correction`,
        {
          expectedRevision: revision,
          reason: input.reason,
          memberId: target === "" ? null : target,
          dryRun: input.dryRun,
        },
      ),
    (result, input) => {
      if (input.dryRun) {
        setPreview(result);
        return;
      }
      setOpen(false);
      setPreview(null);
      setReason("");
      setTarget("");
      onCorrected();
    },
    { refresh: (_result, input) => !input.dryRun },
  );
  const close = () => {
    setOpen(false);
    setPreview(null);
  };
  const others = members.filter((member) => member.id !== volunteerId);
  const send = (dryRun: boolean) => {
    if (reasonText === null) {
      setReasonError(true);
      return;
    }
    if (tooLong) return;
    mutation.mutate({ dryRun, reason: reasonText });
  };

  return (
    <>
      <div>
        <Button
          variant="secondary"
          onClick={() => {
            mutation.reset();
            setPreview(null);
            setReasonError(false);
            setOpen(true);
          }}
          data-testid="volunteer-correct-open"
        >
          {t("volunteerCorrect")}
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={close}
        title={t("volunteerCorrectTitle")}
        description={t("volunteerCorrectBody", { person: volunteer })}
        closeLabel={t("close")}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {t("cancel")}
            </Button>
            <Button
              loading={mutation.busy}
              disabled={tooLong}
              onClick={() => {
                send(preview === null);
              }}
              data-testid={preview ? "volunteer-correct-confirm" : "volunteer-correct-preview"}
            >
              {preview ? t("volunteerCorrectConfirm") : t("volunteerPreview")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <SelectField
            label={t("volunteerCorrectTarget")}
            value={target}
            disabled={preview !== null}
            options={[
              { value: "", label: t("volunteerCorrectToReview") },
              ...others.map((member) => ({ value: member.id, label: texts.member(member.id) })),
            ]}
            onChange={(event) => {
              setTarget(event.target.value);
            }}
            data-testid="volunteer-correct-target"
          />
          <TextArea
            label={t("volunteerCorrectReason")}
            description={t("volunteerCorrectReasonHelp", { max: CHORE_LIMITS.reason })}
            required
            rows={3}
            value={reason}
            readOnly={preview !== null}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonError(false);
            }}
            error={
              reasonError ? t("fieldRejectReasonRequired") : tooLong ? t("fieldTooLong") : undefined
            }
            data-testid="volunteer-correct-reason"
          />
          {preview ? (
            <p className="text-body text-fg" role="status" data-testid="volunteer-correct-summary">
              {target === ""
                ? t("volunteerCorrectPreviewReview", { person: volunteer })
                : t("volunteerCorrectPreviewMember", {
                    person: volunteer,
                    member: texts.member(target),
                  })}
              {preview.overdue ? ` ${t("volunteerCorrectOverdue")}` : ""}
            </p>
          ) : null}
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
