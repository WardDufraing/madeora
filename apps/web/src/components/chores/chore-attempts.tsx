"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";

import type { ChoreSubmission } from "@/chores/api";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import { memberNames, type MemberOption } from "@/tasks/format";

import { useChoreTexts } from "./use-chore-texts";

const statusKey = {
  pending: "attemptPending",
  approved: "attemptApproved",
  rejected: "attemptRejected",
  withdrawn: "attemptWithdrawn",
} as const satisfies Record<ChoreSubmission["status"], string>;

/**
 * Every attempt at completing an occurrence of a chore that requires approval (S20), newest first:
 * who submitted it for whom and when, the note, the checklist as it stood, and the decision with
 * the reviewer, the time and a rejection's reason. Nothing is ever removed from it.
 */
export function ChoreAttempts({
  submissions,
  members,
  formats,
}: {
  readonly submissions: readonly ChoreSubmission[];
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
}) {
  const t = useTranslations("Chores");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useChoreTexts(names);
  if (submissions.length === 0) return null;
  return (
    <section aria-labelledby="chore-attempts-heading" className="flex flex-col gap-2">
      <h2 id="chore-attempts-heading" className="text-section-title font-semibold text-fg">
        {t("attemptsHeading")}
      </h2>
      <ol
        className="flex flex-col divide-y divide-line rounded-card border border-line"
        data-testid="chore-attempts"
      >
        {submissions.map((submission) => (
          <li key={submission.id} className="flex flex-col gap-1 p-3 text-body text-fg">
            <p className="font-medium">
              {t("attemptLine", {
                attempt: submission.attempt,
                status: t(statusKey[submission.status]),
              })}
            </p>
            <p>
              {t("attemptSubmitted", {
                person: texts.person(submission.by),
                contributor: texts.person(submission.contributor),
                date: formatDateTime(submission.at, formats),
              })}
            </p>
            {submission.steps.length > 0 ? (
              <p className="text-fg-muted">
                {t("attemptSteps", {
                  done: submission.steps.filter((step) => step.checked).length,
                  total: submission.steps.length,
                })}
              </p>
            ) : null}
            {submission.note ? (
              <p>
                <span className="font-medium">{t("noteLabel")}</span>{" "}
                <span className="break-words">{submission.note}</span>
              </p>
            ) : null}
            {submission.decidedAt && submission.status !== "pending" ? (
              <p>
                {t(
                  submission.status === "approved"
                    ? submission.selfApproved
                      ? "attemptDecidedSelf"
                      : "attemptDecidedApproved"
                    : submission.status === "rejected"
                      ? "attemptDecidedRejected"
                      : "attemptDecidedWithdrawn",
                  {
                    person: texts.person(submission.decidedBy),
                    date: formatDateTime(submission.decidedAt, formats),
                  },
                )}
              </p>
            ) : null}
            {submission.reason ? (
              <p>
                <span className="font-medium">{t("reasonLabel")}</span>{" "}
                <span className="break-words">{submission.reason}</span>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
