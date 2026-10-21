"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextArea } from "@/components/ui/text-area";
import { CHORE_OCCURRENCES_ENDPOINT, sendChoreRequest, type ReviewResponse } from "@/chores/api";
import { CHORE_LIMITS, normalizeShortText } from "@/chores/schema";
import { noMembers } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

export interface ChoreReviewProps {
  readonly occurrenceId: string;
  /** The occurrence's revision the reviewer sees: a decision on anything newer is refused. */
  readonly revision: number;
  readonly title: string;
  /** What is being approved, in words ("Done by Bea, reported 21/10/2026 18:05"). */
  readonly summary: string;
  /** The contributor left the Home: approval is not possible, rejection is. */
  readonly contributorGone?: boolean;
  /** Called with the decision after it was recorded. */
  readonly onDecided?: (decision: "approved" | "rejected") => void;
  readonly compact?: boolean;
}

/**
 * Approve or reject a pending submission (S20; chore reviewers only, the database checks again).
 * Both ask for confirmation: approving shows what will be recorded as completed; rejecting needs a
 * reason (1-500 characters), which the contributor sees with Needs rework. Used on the occurrence
 * page, the review queue and the Pending Approvals widget.
 */
export function ChoreReview({
  occurrenceId,
  revision,
  title,
  summary,
  contributorGone = false,
  onDecided,
  compact = false,
}: ChoreReviewProps) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const mutation = useChoreMutation(
    `chore-occurrence:${occurrenceId}`,
    (input: { decision: "approve" | "reject"; reason: string | null }) =>
      sendChoreRequest<ReviewResponse>(
        "POST",
        `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}/review`,
        { expectedRevision: revision, ...input },
      ),
    (result) => {
      setDialog(null);
      setReason("");
      onDecided?.(result.outcome);
    },
  );
  const reasonText = normalizeShortText(reason);
  const tooLong = reasonText !== null && reasonText.length > CHORE_LIMITS.reason;
  const close = () => {
    setDialog(null);
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          size={compact ? "sm" : "md"}
          disabled={contributorGone}
          onClick={() => {
            mutation.reset();
            setDialog("approve");
          }}
          aria-label={compact ? t("approveNamed", { title }) : undefined}
          data-testid="chore-approve-open"
        >
          {t("approve")}
        </Button>
        <Button
          size={compact ? "sm" : "md"}
          variant="secondary"
          onClick={() => {
            mutation.reset();
            setReasonError(false);
            setDialog("reject");
          }}
          aria-label={compact ? t("rejectNamed", { title }) : undefined}
          data-testid="chore-reject-open"
        >
          {t("reject")}
        </Button>
      </div>
      {contributorGone ? <p className="text-helper text-fg-muted">{t("contributorGone")}</p> : null}
      {mutation.error && dialog === null ? (
        <FormAlert tone="error" announce>
          {texts.failure(mutation.error.failure, mutation.error.detail)}
        </FormAlert>
      ) : null}

      <Dialog
        open={dialog === "approve"}
        onClose={close}
        title={t("approveTitle")}
        description={t("approveBody", { title, summary })}
        closeLabel={t("close")}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {t("cancel")}
            </Button>
            <Button
              loading={mutation.busy}
              onClick={() => {
                mutation.mutate({ decision: "approve", reason: null });
              }}
              data-testid="chore-approve-confirm"
            >
              {t("approve")}
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

      <Dialog
        open={dialog === "reject"}
        onClose={close}
        title={t("rejectTitle")}
        description={t("rejectBody", { title, summary })}
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
                mutation.mutate({ decision: "reject", reason: reasonText });
              }}
              data-testid="chore-reject-confirm"
            >
              {t("reject")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <TextArea
            label={t("fieldRejectReason")}
            description={t("fieldRejectReasonHelp", { max: CHORE_LIMITS.reason })}
            rows={3}
            required
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonError(false);
            }}
            error={
              reasonError ? t("fieldRejectReasonRequired") : tooLong ? t("fieldTooLong") : undefined
            }
            data-testid="chore-reject-reason"
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
