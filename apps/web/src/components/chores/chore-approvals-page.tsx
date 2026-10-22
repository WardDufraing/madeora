import { choreAward } from "@madeora/domain/points";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { LabelChip } from "@/components/tasks/label-chip";
import { EmptyState, ErrorState } from "@/components/ui/states";
import type { ChorePerson } from "@/chores/api";
import { getChoreContext, listChoreApprovals } from "@/chores/data";
import { choresPath } from "@/chores/format";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { listChorePoints } from "@/points/data";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate, memberNames, personName } from "@/tasks/format";

import { ChoreReview } from "./chore-review";

/**
 * A Home's review queue (S20; spec "Confirmed optional approval of chore completions"): every
 * completion waiting for approval, oldest first, with who submitted it for whom and when, whether
 * it was reported late and (S23) the points approving it awards, the note and the checklist, and
 * approve or reject on each. Chore reviewers
 * only: anyone else is told so and gets no rows from the database.
 */
export async function ChoreApprovalsPage({
  home,
}: {
  readonly home: { readonly id: string; readonly name: string };
}) {
  const [t, formats, context, approvals, members] = await Promise.all([
    getTranslations("Chores"),
    getDateTimeFormats(),
    getChoreContext(home.id),
    listChoreApprovals(home.id),
    listTaskMembers(home.id),
  ]);
  const base = choresPath(home.id);
  const header = (
    <>
      <PageHeader title={t("approvalsTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={base} className="font-medium text-accent-fg underline">
          {t("backToChores")}
        </Link>
      </p>
    </>
  );
  if (context.status !== "ok" || approvals.status !== "ok" || members.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  if (!context.value.canReview) {
    return (
      <>
        {header}
        <EmptyState
          title={t("approvalsNotReviewerTitle")}
          description={t("approvalsNotReviewer")}
        />
      </>
    );
  }
  const names = memberNames(members.value);
  const who = (person: ChorePerson | null) => {
    if (person === null) return t("personFormer");
    const name = personName(person, names);
    return name.kind === "me"
      ? t("personYou")
      : name.kind === "member"
        ? name.name
        : name.kind === "unnamed"
          ? t("personUnnamed")
          : t("personFormer");
  };

  const points = await listChorePoints(
    home.id,
    approvals.value.map((item) => item.occurrenceId),
  );
  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-4">
        <p className="text-body text-fg-muted">{t("approvalsIntro")}</p>
        {approvals.value.length === 0 ? (
          <EmptyState title={t("approvalsEmptyTitle")} description={t("approvalsEmpty")} />
        ) : (
          <ul
            className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
            data-testid="chore-approvals"
          >
            {approvals.value.map((item) => {
              const setting =
                points.status === "ok" ? points.value.get(item.occurrenceId) : undefined;
              const award = setting ? choreAward(setting, item.late) : null;
              const reported = formatDateTime(item.submittedAt, formats);
              const summary = t("submissionSummary", {
                contributor: who(item.contributor),
                date: reported,
              });
              return (
                <li
                  key={item.submissionId}
                  className="flex flex-col gap-2 p-4"
                  data-testid="chore-approval"
                >
                  <Link
                    href={`${base}/${item.occurrenceId}`}
                    className="text-body font-semibold text-fg underline-offset-2 hover:underline"
                  >
                    <bdi>{item.title}</bdi>
                  </Link>
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-helper text-fg-muted">
                    {item.category ? (
                      <LabelChip name={item.category.name} color={item.category.color} />
                    ) : (
                      <span>{t("uncategorized")}</span>
                    )}
                    <span>{t("dueOn", { date: formatTaskDate(item.dueDate, formats) })}</span>
                    {item.late ? (
                      <span className="font-semibold text-fg">{t("reportedLate")}</span>
                    ) : null}
                    {item.attempt > 1 ? (
                      <span>{t("attemptNumber", { attempt: item.attempt })}</span>
                    ) : null}
                    {award !== null && setting && setting.points > 0 ? (
                      <span className="font-medium text-fg" data-testid="chore-approval-points">
                        {t("approvalAward", { count: award })}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-body text-fg">
                    {t("pendingRecord", {
                      person: who(item.submittedBy),
                      contributor: who(item.contributor),
                      date: reported,
                    })}
                  </p>
                  {item.stepsTotal > 0 ? (
                    <p className="text-body text-fg-muted">
                      {t("attemptSteps", { done: item.stepsDone, total: item.stepsTotal })}
                    </p>
                  ) : null}
                  {item.note ? (
                    <p className="text-body text-fg">
                      <span className="font-medium">{t("noteLabel")}</span>{" "}
                      <span className="break-words">{item.note}</span>
                    </p>
                  ) : null}
                  <ChoreReview
                    occurrenceId={item.occurrenceId}
                    revision={item.revision}
                    title={item.title}
                    summary={summary}
                    contributorGone={!item.contributorCurrent}
                    compact
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
