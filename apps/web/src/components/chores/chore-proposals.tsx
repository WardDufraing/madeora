"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextArea } from "@/components/ui/text-area";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { CHORE_PROPOSALS_ENDPOINT, sendChoreRequest, type ChoreProposal } from "@/chores/api";
import { CHORE_LIMITS, normalizeShortText } from "@/chores/schema";
import type { DateTimeFormats } from "@/invitations/format";
import { formatTaskDate, noMembers } from "@/tasks/format";

import { ProposalForm, proposalDefaults, type ProposalFields } from "./proposal-form";
import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

type Categories = readonly { readonly id: string; readonly name: string }[];

/**
 * Suggesting a chore (S21; spec "Member-proposed chores"): any current member fills in a one-off
 * chore for a chore manager to review. Each opening of the form gets a fresh id, so a retry after a
 * lost answer finds the proposal already there instead of sending a second one.
 */
export function ProposeChore({
  homeId,
  categories,
  today,
}: {
  readonly homeId: string;
  readonly categories: Categories;
  readonly today: string;
}) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const [open, setOpen] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const opener = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const mutation = useChoreMutation(
    `chore-propose:${draftId}`,
    (input: ProposalFields) =>
      sendChoreRequest("POST", CHORE_PROPOSALS_ENDPOINT, { id: draftId, homeId, ...input }),
    () => {
      announce(t("announceProposed"));
      setDraftId(crypto.randomUUID());
      setOpen(false);
      requestAnimationFrame(() => opener.current?.focus());
    },
  );

  return (
    <section aria-labelledby="propose-chore-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="propose-chore-heading" className="text-section-title font-semibold text-fg">
          {t("proposeHeading")}
        </h2>
        {!open ? (
          <div>
            <Button
              ref={opener}
              onClick={() => {
                setOpen(true);
              }}
              data-testid="propose-open"
            >
              {t("proposeChore")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4">
            <p className="text-body text-fg-muted">{t("proposeIntro")}</p>
            <ProposalForm
              defaults={proposalDefaults(today)}
              categories={categories}
              today={today}
              busy={mutation.busy}
              onSubmit={(values) => {
                mutation.mutate(values);
              }}
              onCancel={() => {
                setOpen(false);
                mutation.reset();
                requestAnimationFrame(() => opener.current?.focus());
              }}
              submitLabel={t("proposeSubmit")}
              testId="propose-form"
            />
            {mutation.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(mutation.error.failure, mutation.error.detail)}
              </FormAlert>
            ) : null}
          </div>
        )}
      </HydrationGate>
    </section>
  );
}

type Decision =
  | { readonly action: "withdraw" }
  | { readonly action: "reject"; readonly reason: string }
  | ({ readonly action: "approve" } & ProposalFields);

/**
 * The actions on one proposal (S21): its proposer withdraws it while it waits; a chore manager
 * approves it, after revising any field and confirming the final values, or rejects it with a
 * reason (1-500 characters) the proposer sees. Every decision carries the revision the person saw,
 * so two reviewers cannot both decide; the database checks every right again.
 */
export function ProposalActions({
  proposal,
  categories,
  today,
  formats,
}: {
  readonly proposal: ChoreProposal;
  readonly categories: Categories;
  readonly today: string;
  readonly formats: DateTimeFormats;
}) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const [dialog, setDialog] = useState<"withdraw" | "reject" | "confirm" | null>(null);
  const [revising, setRevising] = useState(false);
  const [final, setFinal] = useState<ProposalFields | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const { announce, region } = useAnnouncer();
  const mutation = useChoreMutation(
    `chore-proposal:${proposal.id}`,
    (decision: Decision) =>
      sendChoreRequest("PATCH", `${CHORE_PROPOSALS_ENDPOINT}/${proposal.id}`, {
        expectedRevision: proposal.revision,
        ...decision,
      }),
    (_result, decision) => {
      setDialog(null);
      setRevising(false);
      announce(
        decision.action === "approve"
          ? t("announceProposalApproved")
          : decision.action === "reject"
            ? t("announceProposalRejected")
            : t("announceProposalWithdrawn"),
      );
    },
  );
  const close = () => {
    setDialog(null);
  };
  const reasonText = normalizeShortText(reason);
  const tooLong = reasonText !== null && reasonText.length > CHORE_LIMITS.reason;
  const category = (categoryId: string | null) =>
    categoryId === null
      ? t("uncategorized")
      : (categories.find((item) => item.id === categoryId)?.name ?? t("uncategorized"));
  const error =
    mutation.error && dialog === null ? (
      <FormAlert tone="error" announce>
        {texts.failure(mutation.error.failure, mutation.error.detail)}
      </FormAlert>
    ) : null;

  return (
    <div className="flex flex-col gap-3">
      {region}
      {!revising ? (
        <div className="flex flex-wrap gap-2">
          {proposal.canReview ? (
            <>
              <Button
                size="sm"
                onClick={() => {
                  mutation.reset();
                  setRevising(true);
                }}
                aria-label={t("proposalReviewNamed", { title: proposal.title })}
                data-testid="proposal-review-open"
              >
                {t("proposalReview")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  mutation.reset();
                  setReason("");
                  setReasonError(false);
                  setDialog("reject");
                }}
                aria-label={t("rejectNamed", { title: proposal.title })}
                data-testid="proposal-reject-open"
              >
                {t("reject")}
              </Button>
            </>
          ) : null}
          {proposal.canWithdraw ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                mutation.reset();
                setDialog("withdraw");
              }}
              aria-label={t("proposalWithdrawNamed", { title: proposal.title })}
              data-testid="proposal-withdraw-open"
            >
              {t("proposalWithdraw")}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-card border border-line bg-surface-sunken p-4">
          <h3 className="text-body font-semibold text-fg">{t("proposalReviseHeading")}</h3>
          <p className="text-helper text-fg-muted">{t("proposalReviseIntro")}</p>
          <ProposalForm
            defaults={proposalDefaults(today, {
              ...proposal,
              categoryId:
                proposal.category && categories.some((item) => item.id === proposal.category?.id)
                  ? proposal.category.id
                  : null,
            })}
            categories={categories}
            today={today}
            busy={mutation.busy}
            onSubmit={(values) => {
              mutation.reset();
              setFinal(values);
              setDialog("confirm");
            }}
            onCancel={() => {
              setRevising(false);
              mutation.reset();
            }}
            submitLabel={t("proposalApproveNext")}
            testId="proposal-revise-form"
          />
        </div>
      )}
      {error}

      <Dialog
        open={dialog === "confirm" && final !== null}
        onClose={close}
        title={t("proposalApproveTitle")}
        description={t("proposalApproveBody")}
        closeLabel={t("close")}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {t("cancel")}
            </Button>
            <Button
              loading={mutation.busy}
              onClick={() => {
                if (final) mutation.mutate({ action: "approve", ...final });
              }}
              data-testid="proposal-approve-confirm"
            >
              {t("proposalApprove")}
            </Button>
          </>
        }
      >
        {final ? (
          <dl
            className="grid gap-x-4 gap-y-1 text-body sm:grid-cols-[max-content_1fr]"
            data-testid="proposal-final"
          >
            <dt className="font-medium text-fg">{t("fieldTitle")}</dt>
            <dd className="break-words text-fg">
              <bdi>{final.title}</bdi>
            </dd>
            <dt className="font-medium text-fg">{t("fieldDueDate")}</dt>
            <dd className="text-fg">{formatTaskDate(final.dueDate, formats)}</dd>
            <dt className="font-medium text-fg">{t("fieldCategory")}</dt>
            <dd className="text-fg">{category(final.categoryId)}</dd>
            <dt className="font-medium text-fg">{t("fieldMinutes")}</dt>
            <dd className="text-fg">
              {final.minutes === null ? t("noEstimate") : t("minutes", { count: final.minutes })}
            </dd>
            <dt className="font-medium text-fg">{t("proposalStepsLabel")}</dt>
            <dd className="text-fg">
              {final.steps.length === 0
                ? t("proposalNoSteps")
                : t("proposalStepCount", { count: final.steps.length })}
            </dd>
            <dt className="font-medium text-fg">{t("fieldAssignees")}</dt>
            <dd className="text-fg">{t("proposalPublishedUnassigned")}</dd>
          </dl>
        ) : null}
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure, mutation.error.detail)}
          </FormAlert>
        ) : null}
      </Dialog>

      <Dialog
        open={dialog === "reject"}
        onClose={close}
        title={t("proposalRejectTitle")}
        description={t("proposalRejectBody", { title: proposal.title })}
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
                if (reasonText === null) {
                  setReasonError(true);
                  return;
                }
                mutation.mutate({ action: "reject", reason: reasonText });
              }}
              data-testid="proposal-reject-confirm"
            >
              {t("reject")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <TextArea
            label={t("fieldRejectReason")}
            description={t("proposalRejectReasonHelp", { max: CHORE_LIMITS.reason })}
            required
            rows={3}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonError(false);
            }}
            error={
              reasonError ? t("fieldRejectReasonRequired") : tooLong ? t("fieldTooLong") : undefined
            }
            data-testid="proposal-reject-reason"
          />
          {mutation.error ? (
            <FormAlert tone="error" announce>
              {texts.failure(mutation.error.failure, mutation.error.detail)}
            </FormAlert>
          ) : null}
        </div>
      </Dialog>

      <Dialog
        open={dialog === "withdraw"}
        onClose={close}
        title={t("proposalWithdrawTitle")}
        description={t("proposalWithdrawBody", { title: proposal.title })}
        closeLabel={t("close")}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {t("cancel")}
            </Button>
            <Button
              loading={mutation.busy}
              onClick={() => {
                mutation.mutate({ action: "withdraw" });
              }}
              data-testid="proposal-withdraw-confirm"
            >
              {t("proposalWithdraw")}
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
