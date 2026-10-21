"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_OCCURRENCES_ENDPOINT,
  sendChoreRequest,
  type ChoreClaimState,
  type ClaimBlock,
  type ReassignmentAction,
  type ReassignmentRequest,
  type ReleaseResponse,
} from "@/chores/api";
import { CHORE_LIMITS, normalizeShortText } from "@/chores/schema";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import { addDays } from "@/tasks/calendar";
import { formatTaskDate, memberNames, type MemberOption } from "@/tasks/format";

import { useChoreFieldMessage } from "./chore-form";
import { ClaimButton } from "./chore-pool";
import { RequestActions } from "./chore-requests";
import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

export interface ChoreClaimProps {
  readonly occurrenceId: string;
  readonly title: string;
  readonly state: ChoreClaimState;
  /** Current members (membership ids), for choosing who to ask. */
  readonly members: readonly MemberOption[];
  /** Who is on the occurrence now (they cannot be asked). */
  readonly assigneeIds: readonly (string | null)[];
  /** Checklist steps ticked now: releasing clears them. */
  readonly stepsChecked: number;
  readonly formats: DateTimeFormats;
}

const blockKey = {
  already_claimed: null,
  assigned: null,
  not_claimable: "claimBlockNobody",
  not_eligible: "notEligible",
  expired: "claimBlockExpired",
  pending_approval: null,
  already_completed: null,
  already_skipped: null,
} as const satisfies Record<ClaimBlock, string | null>;

const requestStatusKey = {
  pending: "requestStatusPending",
  awaiting_manager: "requestStatusAwaiting",
  accepted: "requestStatusAccepted",
  declined: "requestStatusDeclined",
  cancelled: "requestStatusCancelled",
  invalidated: "requestStatusInvalidated",
  refused: "requestStatusRefused",
} as const satisfies Record<ReassignmentRequest["status"], string>;

const invalidKey = {
  occurrence_closed: "requestInvalid_occurrence_closed",
  assignment_changed: "requestInvalid_assignment_changed",
  member_left: "requestInvalid_member_left",
} as const satisfies Record<NonNullable<ReassignmentRequest["invalidReason"]>, string>;

/**
 * An occurrence's claim and handover (S21): who may claim its chore, what happens after its week
 * and when a claim is released automatically; Claim or "Not eligible to claim"; who has it and
 * Release (for the claimant or a chore manager, warning that checklist progress is cleared); asking
 * another member to take it over; and the requests the viewer may see, with their answers.
 */
export function ChoreClaim({
  occurrenceId,
  title,
  state,
  members,
  assigneeIds,
  stepsChecked,
  formats,
}: ChoreClaimProps) {
  const t = useTranslations("Chores");
  const names = memberNames(members);
  const selfId = names.selfId;
  const texts = useChoreTexts(names);
  const { announce, region } = useAnnouncer();
  const [confirmRelease, setConfirmRelease] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const release = useChoreMutation(
    `chore-occurrence:${occurrenceId}`,
    () =>
      sendChoreRequest<ReleaseResponse>(
        "POST",
        `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}/release`,
        { undo: false },
      ),
    (result) => {
      setConfirmRelease(false);
      announce(result.status === "expired" ? t("announceReleasedClosed") : t("announceReleased"));
      statusRef.current?.focus();
    },
    { refreshOnError: (failure) => failure === "notClaimed" || failure === "occurrenceClosed" },
  );
  const block = state.block ? blockKey[state.block] : null;
  const policy =
    state.claimMode === "all"
      ? t("claimModeAll")
      : state.claimMode === "selected"
        ? t("claimModeSelected")
        : t("claimModeNone");
  const releaseAfter =
    state.autoReleaseHours === null
      ? t("autoReleaseOff")
      : t("autoReleaseAfter", { count: state.autoReleaseHours });

  return (
    <section aria-labelledby="chore-claim-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="chore-claim-heading" className="text-section-title font-semibold text-fg">
          {t("claimHeading")}
        </h2>
        <dl className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-[max-content_1fr]">
          <dt className="font-medium text-fg">{t("fieldClaimMode")}</dt>
          <dd className="text-fg">{policy}</dd>
          <dt className="font-medium text-fg">{t("fieldExpiry")}</dt>
          <dd className="text-fg">
            {state.expiryPolicy === "week_end" ? t("expiryWeekEnd") : t("expiryOverdue")}
            {state.closesOn ? (
              <span className="ms-2 text-fg-muted">
                {t("poolClosesAfter", {
                  date: formatTaskDate(addDays(state.closesOn, -1), formats),
                })}
              </span>
            ) : null}
          </dd>
          <dt className="font-medium text-fg">{t("fieldAutoRelease")}</dt>
          <dd className="text-fg">{releaseAfter}</dd>
        </dl>
        <p
          ref={statusRef}
          tabIndex={-1}
          className="text-body text-fg outline-none"
          data-testid="chore-claim-status"
        >
          {state.claimedBy
            ? t("claimedRecord", {
                person: texts.person(state.claimedBy),
                date: state.claimedAt ? formatDateTime(state.claimedAt, formats) : "",
              })
            : state.claimable
              ? t("claimOpen")
              : block
                ? t(block)
                : t("claimNotInPool")}
          {state.claimedBy && state.releaseAt
            ? ` ${t("releaseAtRecord", { date: formatDateTime(state.releaseAt, formats) })}`
            : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          {state.claimable ? (
            <ClaimButton occurrenceId={occurrenceId} title={title} variant="primary" />
          ) : null}
          {state.canRelease ? (
            <Button
              variant="secondary"
              onClick={() => {
                release.reset();
                setConfirmRelease(true);
              }}
              data-testid="chore-release-open"
            >
              {t("release")}
            </Button>
          ) : null}
        </div>
        <Dialog
          open={confirmRelease}
          onClose={() => {
            setConfirmRelease(false);
          }}
          title={t("releaseTitle")}
          description={
            stepsChecked > 0
              ? t("releaseProgressWarning", { count: stepsChecked })
              : t("releaseDescription")
          }
          closeLabel={t("close")}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirmRelease(false);
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                loading={release.busy}
                onClick={() => {
                  release.mutate(undefined);
                }}
                data-testid="chore-release-confirm"
              >
                {t("release")}
              </Button>
            </>
          }
        >
          {release.error ? (
            <FormAlert tone="error" announce>
              {texts.failure(release.error.failure)}
            </FormAlert>
          ) : null}
        </Dialog>
        {state.canRequest ? (
          <RequestForm
            occurrenceId={occurrenceId}
            // A chore manager who is not an assignee may ask on behalf of one of them.
            onBehalfOf={
              state.canRequestForOthers && !assigneeIds.some((id) => id === selfId)
                ? members.filter((member) => assigneeIds.includes(member.id))
                : []
            }
            members={members.filter((member) => !assigneeIds.includes(member.id))}
            confirmationRequired={state.confirmationRequired}
            onRequested={() => {
              announce(t("announceRequested"));
            }}
          />
        ) : null}
        {state.requests.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-body font-semibold text-fg">{t("requestsOnOccurrence")}</h3>
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="chore-claim-requests"
            >
              {state.requests.map((request) => {
                const actions: ReassignmentAction[] = [
                  ...(request.canAnswer ? (["accept", "decline"] as const) : []),
                  ...(request.canConfirm ? (["confirm", "refuse"] as const) : []),
                  ...(request.canCancel ? (["cancel"] as const) : []),
                ];
                return (
                  <li
                    key={request.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="flex min-w-0 flex-col gap-1 text-body text-fg">
                      <p>
                        {t("requestLineFull", {
                          by: texts.person(request.by),
                          from: texts.person(request.from),
                          to: texts.person(request.to),
                          date: formatDateTime(request.createdAt, formats),
                        })}
                      </p>
                      <p className="font-medium" data-testid="chore-request-status">
                        {t(requestStatusKey[request.status])}
                        {request.invalidReason ? ` ${t(invalidKey[request.invalidReason])}` : ""}
                      </p>
                      {request.note ? (
                        <p className="break-words text-helper">
                          <span className="font-medium">{t("noteLabel")}</span> {request.note}
                        </p>
                      ) : null}
                    </div>
                    {actions.length > 0 ? (
                      <RequestActions requestId={request.id} title={title} actions={actions} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </HydrationGate>
    </section>
  );
}

const requestFormSchema = z.object({
  toMember: z.string().min(1, "required"),
  fromMember: z.string(),
  note: z
    .string()
    .refine(
      (value) => (normalizeShortText(value) ?? "").length <= CHORE_LIMITS.requestNote,
      "tooLong",
    ),
});
type RequestFormValues = z.infer<typeof requestFormSchema>;

function RequestForm({
  occurrenceId,
  members,
  onBehalfOf,
  confirmationRequired,
  onRequested,
}: {
  readonly occurrenceId: string;
  readonly members: readonly MemberOption[];
  /** The assignees a chore manager can ask for (empty: the caller asks for themselves). */
  readonly onBehalfOf: readonly MemberOption[];
  readonly confirmationRequired: boolean;
  readonly onRequested: () => void;
}) {
  const t = useTranslations("Chores");
  const names = memberNames([...members, ...onBehalfOf]);
  const texts = useChoreTexts(names);
  const message = useChoreFieldMessage();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  // One id per request being written, so a retried send answers the same request.
  const requestId = useRef<string | null>(null);
  const form = useForm<RequestFormValues>({
    resolver: zodResolver(requestFormSchema),
    defaultValues: { toMember: "", fromMember: "", note: "" },
  });
  const mutation = useChoreMutation(
    `chore-occurrence:${occurrenceId}`,
    (values: RequestFormValues) => {
      requestId.current ??= crypto.randomUUID();
      return sendChoreRequest<{ outcome: string }>(
        "POST",
        `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}/reassignment-requests`,
        {
          id: requestId.current,
          toMember: values.toMember,
          note: normalizeShortText(values.note),
          ...(onBehalfOf.length > 0 ? { fromMember: values.fromMember } : {}),
        },
      );
    },
    () => {
      requestId.current = null;
      setOpen(false);
      onRequested();
      requestAnimationFrame(() => opener.current?.focus());
    },
  );
  if (members.length === 0) return null;
  if (!open) {
    return (
      <div>
        <Button
          ref={opener}
          variant="secondary"
          onClick={() => {
            form.reset();
            mutation.reset();
            requestId.current = null;
            setOpen(true);
          }}
          data-testid="chore-request-open"
        >
          {t("requestOpen")}
        </Button>
      </div>
    );
  }
  return (
    <form
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          if (onBehalfOf.length > 0 && values.fromMember === "") {
            form.setError("fromMember", { message: "required" });
            return;
          }
          mutation.mutate(values);
        })(event);
      }}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      data-testid="chore-request-form"
    >
      <p className="text-helper text-fg-muted">
        {confirmationRequired ? t("requestHelpConfirm") : t("requestHelp")}
      </p>
      {onBehalfOf.length > 0 ? (
        <>
          <SelectField
            label={t("requestFrom")}
            required
            options={[
              { value: "", label: t("requestChooseFrom") },
              ...onBehalfOf.map((member) => ({
                value: member.id,
                label: texts.person({ me: false, member: member.id }),
              })),
            ]}
            {...form.register("fromMember")}
          />
          {form.formState.errors.fromMember ? (
            <FormAlert tone="error">{t("requestChooseFromError")}</FormAlert>
          ) : null}
        </>
      ) : null}
      <SelectField
        label={t("requestTo")}
        required
        options={[
          { value: "", label: t("requestChoose") },
          ...members.map((member) => ({
            value: member.id,
            label: texts.person({ me: false, member: member.id }),
          })),
        ]}
        {...form.register("toMember")}
      />
      {form.formState.errors.toMember ? (
        <FormAlert tone="error">{t("requestChooseError")}</FormAlert>
      ) : null}
      <TextArea
        label={t("requestNote")}
        rows={2}
        error={message(form.formState.errors.note)}
        {...form.register("note")}
      />
      {mutation.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(mutation.error.failure)}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={mutation.busy} data-testid="chore-request-send">
          {t("requestSend")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(false);
            requestAnimationFrame(() => opener.current?.focus());
          }}
        >
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
