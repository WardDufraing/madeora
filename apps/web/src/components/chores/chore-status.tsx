"use client";

import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { PointsChangeNote } from "@/components/points/points-change";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_OCCURRENCES_ENDPOINT,
  sendChoreRequest,
  type ChoreOccurrenceDetail,
  type CompleteResponse,
  type RevisionResponse,
} from "@/chores/api";
import { CHORE_LIMITS, normalizeShortText } from "@/chores/schema";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import { memberNames, type MemberOption } from "@/tasks/format";

import { ChoreCorrect } from "./chore-correct";
import { ChoreReview } from "./chore-review";
import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

export interface ChoreStatusProps {
  readonly occurrence: ChoreOccurrenceDetail;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
  /** The points this completed occurrence carries (S23): reopening it asks first, with the change. */
  readonly awardedPoints?: number | null;
}

type Dialogs = "complete" | "skip" | "reopen" | null;

/**
 * The occurrence's state and record (S20): open (or overdue), Needs rework with the reviewer's
 * reason, Pending approval with the attempt that waits, completed with who did it, who recorded it
 * and who approved it, or skipped with the reason. Any member completes (for a chore that requires
 * approval: submits), naming who actually did the work (asked explicitly when it is not their own
 * chore); reviewers approve or reject; chore managers skip, reopen (withdrawing a pending
 * submission) and correct a completed record.
 */
export function ChoreStatus({
  occurrence,
  members,
  formats,
  awardedPoints = null,
}: ChoreStatusProps) {
  const t = useTranslations("Chores");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useChoreTexts(names);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const { announce, region } = useAnnouncer();
  const [dialog, setDialog] = useState<Dialogs>(null);
  // The person completing is the natural contributor only for their own or nobody's chore.
  const natural =
    occurrence.assignedToMe || occurrence.assigneeIds.length === 0 ? (names.selfId ?? "") : "";
  const [contributor, setContributor] = useState(natural);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [contributorError, setContributorError] = useState(false);
  const url = `${CHORE_OCCURRENCES_ENDPOINT}/${occurrence.id}`;
  const scope = `chore-occurrence:${occurrence.id}`;
  const close = () => {
    setDialog(null);
  };
  const done = (message: string) => {
    announce(message);
    setDialog(null);
    statusRef.current?.focus();
  };

  const completion = useChoreMutation(
    scope,
    (input: { contributor: string; note: string | null }) =>
      sendChoreRequest<CompleteResponse>("PUT", `${url}/completion`, input),
    (result) => {
      done(
        result.outcome === "already_completed" && result.completedBy && !result.completedBy.me
          ? t("alreadyCompletedBy", { person: texts.person(result.completedBy) })
          : result.outcome === "already_submitted"
            ? t("alreadySubmittedBy", { person: texts.person(result.completedBy) })
            : result.outcome === "submitted"
              ? t("announceSubmitted", { title: occurrence.chore.title })
              : t("announceCompleted", { title: occurrence.chore.title }),
      );
    },
  );
  const skip = useChoreMutation(
    scope,
    (input: { reason: string | null }) =>
      sendChoreRequest<RevisionResponse>("POST", `${url}/skip`, input),
    () => {
      done(t("announceSkipped"));
    },
  );
  const reopen = useChoreMutation(
    scope,
    () => sendChoreRequest<RevisionResponse>("POST", `${url}/reopen`, {}),
    () => {
      done(t("announceReopened"));
    },
  );
  const error = completion.error ?? skip.error ?? reopen.error;
  const noteText = normalizeShortText(note);
  const reasonText = normalizeShortText(reason);
  const openMandatory = occurrence.steps.filter((step) => step.mandatory && !step.checked).length;
  const pending = occurrence.submissions.find((submission) => submission.status === "pending");
  const rejected = occurrence.inRework
    ? occurrence.submissions.find((submission) => submission.status === "rejected")
    : undefined;
  const approval = occurrence.chore.requiresApproval;
  const completeLabel = approval
    ? occurrence.inRework
      ? t("resubmit")
      : t("submitForApproval")
    : t("complete");
  const pendingSummary = pending
    ? t("submissionSummary", {
        contributor: texts.person(pending.contributor),
        date: formatDateTime(pending.at, formats),
      })
    : "";

  return (
    <section aria-labelledby="chore-status-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="chore-status-heading" className="text-section-title font-semibold text-fg">
          {t("statusHeading")}
        </h2>
        <p
          ref={statusRef}
          tabIndex={-1}
          className="text-body text-fg outline-none"
          data-testid="chore-status"
        >
          {occurrence.completion
            ? t("completedRecord", {
                contributor: texts.person(occurrence.completion.contributor),
                person: texts.person(occurrence.completion.by),
                date: formatDateTime(occurrence.completion.at, formats),
              })
            : occurrence.skip
              ? t("skippedRecord", {
                  person: texts.person(occurrence.skip.by),
                  date: formatDateTime(occurrence.skip.at, formats),
                })
              : occurrence.status === "expired"
                ? t("expiredRecord")
                : occurrence.status === "paused"
                  ? t("pausedRecord")
                  : pending
                    ? t("pendingRecord", {
                        person: texts.person(pending.by),
                        contributor: texts.person(pending.contributor),
                        date: formatDateTime(pending.at, formats),
                      })
                    : occurrence.inRework
                      ? occurrence.overdue
                        ? t("statusReworkOverdue")
                        : t("statusRework")
                      : occurrence.overdue
                        ? t("statusOverdue")
                        : t("statusOpen")}
        </p>
        {occurrence.completion?.approvedAt ? (
          <p className="text-body text-fg" data-testid="chore-approved">
            {t("approvedRecord", {
              person: texts.person(occurrence.completion.approvedBy),
              date: formatDateTime(occurrence.completion.approvedAt, formats),
            })}
            {occurrence.submissions.find((submission) => submission.status === "approved")
              ?.selfApproved
              ? ` ${t("selfApproved")}`
              : ""}
          </p>
        ) : null}
        {rejected?.reason ? (
          <div
            className="rounded-card border border-line bg-surface-sunken p-3 text-body text-fg"
            data-testid="chore-rework"
          >
            <p className="font-medium">
              {t("rejectedRecord", {
                person: texts.person(rejected.decidedBy),
                date: rejected.decidedAt ? formatDateTime(rejected.decidedAt, formats) : "",
              })}
            </p>
            <p className="break-words">{rejected.reason}</p>
            {occurrence.can.complete ? (
              <p className="text-helper text-fg-muted">{t("reworkNext")}</p>
            ) : null}
          </div>
        ) : null}
        {pending?.note ? (
          <p className="text-body text-fg" data-testid="chore-note">
            <span className="font-medium">{t("noteLabel")}</span>{" "}
            <span className="break-words">{pending.note}</span>
          </p>
        ) : null}
        {approval && occurrence.status === "open" ? (
          <p className="text-helper text-fg-muted">{t("approvalRequiredHint")}</p>
        ) : null}
        {occurrence.completion?.note ? (
          <p className="text-body text-fg" data-testid="chore-note">
            <span className="font-medium">{t("noteLabel")}</span>{" "}
            <span className="break-words">{occurrence.completion.note}</span>
          </p>
        ) : null}
        {occurrence.skip?.reason ? (
          <p className="text-body text-fg">
            <span className="font-medium">{t("reasonLabel")}</span>{" "}
            <span className="break-words">{occurrence.skip.reason}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {occurrence.can.complete ? (
            <Button
              onClick={() => {
                setContributor(natural);
                setContributorError(false);
                setDialog("complete");
              }}
              data-testid="chore-complete-open"
            >
              {completeLabel}
            </Button>
          ) : null}
          {occurrence.can.manage && occurrence.status === "open" ? (
            <Button
              variant="secondary"
              onClick={() => {
                setDialog("skip");
              }}
              data-testid="chore-skip-open"
            >
              {t("skip")}
            </Button>
          ) : null}
          {occurrence.can.manage &&
          occurrence.status !== "open" &&
          occurrence.status !== "expired" &&
          occurrence.status !== "paused" ? (
            <Button
              variant="secondary"
              loading={reopen.busy}
              onClick={() => {
                if (occurrence.status === "completed" && (awardedPoints ?? 0) !== 0) {
                  reopen.reset();
                  setDialog("reopen");
                  return;
                }
                reopen.mutate(undefined);
              }}
              data-testid="chore-reopen"
            >
              {occurrence.status === "pending_approval" ? t("withdraw") : t("reopen")}
            </Button>
          ) : null}
        </div>
        {occurrence.can.review && pending ? (
          <ChoreReview
            occurrenceId={occurrence.id}
            revision={occurrence.revision}
            title={occurrence.chore.title}
            summary={pendingSummary}
            contributorGone={pending.contributor === null || pending.contributor.member === null}
            onDecided={(decision) => {
              announce(decision === "approved" ? t("announceApproved") : t("announceRejected"));
              statusRef.current?.focus();
            }}
          />
        ) : null}
        {occurrence.can.correct ? (
          <ChoreCorrect
            occurrence={occurrence}
            members={members}
            formats={formats}
            onCorrected={(message) => {
              announce(message);
              statusRef.current?.focus();
            }}
          />
        ) : null}
        {error && dialog === null ? (
          <FormAlert tone="error" announce>
            {texts.failure(error.failure, error.detail)}
          </FormAlert>
        ) : null}

        <Dialog
          open={dialog === "complete"}
          onClose={close}
          title={approval ? t("submitTitle") : t("completeTitle")}
          {...(openMandatory > 0
            ? { description: t("completeStepsOpen", { count: openMandatory }) }
            : approval
              ? { description: t("submitBody") }
              : {})}
          closeLabel={t("close")}
          footer={
            <>
              <Button variant="secondary" onClick={close}>
                {t("cancel")}
              </Button>
              <Button
                loading={completion.busy}
                disabled={openMandatory > 0}
                onClick={() => {
                  if (!contributor) {
                    setContributorError(true);
                    return;
                  }
                  completion.mutate({ contributor, note: noteText });
                }}
                data-testid="chore-complete-confirm"
              >
                {completeLabel}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <SelectField
              label={t("fieldContributor")}
              description={t("fieldContributorHelp")}
              value={contributor}
              onChange={(event) => {
                setContributor(event.target.value);
                setContributorError(false);
              }}
              options={[
                ...(natural ? [] : [{ value: "", label: t("chooseContributor") }]),
                ...members.map((member) => ({
                  value: member.id,
                  label: member.isSelf ? t("personYou") : (member.name ?? t("personUnnamed")),
                })),
              ]}
              aria-invalid={contributorError || undefined}
              data-testid="chore-contributor"
            />
            {contributorError ? (
              <p className="text-helper text-danger" role="alert">
                {t("fieldContributorRequired")}
              </p>
            ) : null}
            <TextArea
              label={t("fieldNote")}
              description={t("fieldNoteHelp", { max: CHORE_LIMITS.note })}
              rows={2}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              error={
                noteText && noteText.length > CHORE_LIMITS.note ? t("fieldTooLong") : undefined
              }
              data-testid="chore-note-input"
            />
            {completion.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(completion.error.failure, completion.error.detail)}
              </FormAlert>
            ) : null}
          </div>
        </Dialog>

        <Dialog
          open={dialog === "reopen"}
          onClose={close}
          title={t("reopenTitle")}
          description={t("reopenPointsBody")}
          closeLabel={t("close")}
          footer={
            <>
              <Button variant="secondary" onClick={close}>
                {t("cancel")}
              </Button>
              <Button
                loading={reopen.busy}
                onClick={() => {
                  reopen.mutate(undefined);
                }}
                data-testid="chore-reopen-confirm"
              >
                {t("reopen")}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <PointsChangeNote
              occurrenceId={occurrence.id}
              request={dialog === "reopen" ? { action: "reopen" } : null}
              names={names}
            />
            {reopen.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(reopen.error.failure, reopen.error.detail)}
              </FormAlert>
            ) : null}
          </div>
        </Dialog>

        <Dialog
          open={dialog === "skip"}
          onClose={close}
          title={t("skipTitle")}
          description={t("skipBody")}
          closeLabel={t("close")}
          footer={
            <>
              <Button variant="secondary" onClick={close}>
                {t("cancel")}
              </Button>
              <Button
                loading={skip.busy}
                onClick={() => {
                  skip.mutate({ reason: reasonText });
                }}
                data-testid="chore-skip-confirm"
              >
                {t("skip")}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <TextArea
              label={t("fieldReason")}
              description={t("fieldReasonHelp", { max: CHORE_LIMITS.reason })}
              rows={2}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              error={
                reasonText && reasonText.length > CHORE_LIMITS.reason
                  ? t("fieldTooLong")
                  : undefined
              }
            />
            {skip.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(skip.error.failure, skip.error.detail)}
              </FormAlert>
            ) : null}
          </div>
        </Dialog>
      </HydrationGate>
    </section>
  );
}
