import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { LabelChip } from "@/components/tasks/label-chip";
import { EmptyState, ErrorState } from "@/components/ui/states";
import type { ChorePerson, ChoreProposal, ProposalStatus } from "@/chores/api";
import { getChoreContext, listChoreCategories, listChoreProposals } from "@/chores/data";
import { choresPath } from "@/chores/format";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate, memberNames, personName } from "@/tasks/format";

import { ProposalActions, ProposeChore } from "./chore-proposals";

const statusKey = {
  pending: "proposalStatusPending",
  approved: "proposalStatusApproved",
  rejected: "proposalStatusRejected",
  withdrawn: "proposalStatusWithdrawn",
} as const satisfies Record<ProposalStatus, string>;

/**
 * A Home's proposed chores (S21; spec "Member-proposed chores"): any current member suggests a
 * one-off chore and follows their own proposals; chore managers see every proposal waiting for
 * review, marked when it may duplicate another, and approve (after revising) or reject it. Decided
 * proposals stay listed for 30 days. Separate from the completion review queue.
 */
export async function ChoreProposalsPage({
  home,
}: {
  readonly home: { readonly id: string; readonly name: string };
}) {
  const [t, formats, context, list, members, categories] = await Promise.all([
    getTranslations("Chores"),
    getDateTimeFormats(),
    getChoreContext(home.id),
    listChoreProposals(home.id),
    listTaskMembers(home.id),
    listChoreCategories(home.id, false),
  ]);
  const base = choresPath(home.id);
  const header = (
    <>
      <PageHeader title={t("proposalsTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={base} className="font-medium text-accent-fg underline">
          {t("backToChores")}
        </Link>
      </p>
    </>
  );
  if (
    context.status !== "ok" ||
    list.status !== "ok" ||
    members.status !== "ok" ||
    categories.status !== "ok"
  ) {
    return (
      <>
        {header}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
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
  const today = context.value.today;
  const active = categories.value
    .filter((category) => !category.archived)
    .map(({ id, name }) => ({ id, name }));
  const waiting = list.value.proposals.filter((proposal) => proposal.status === "pending");
  const decided = list.value.proposals.filter((proposal) => proposal.status !== "pending");

  const item = (proposal: ChoreProposal) => (
    <li key={proposal.id} className="flex flex-col gap-2 p-4" data-testid="chore-proposal">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {proposal.occurrenceId ? (
          <Link
            href={`${base}/${proposal.occurrenceId}`}
            className="text-body font-semibold text-fg underline-offset-2 hover:underline"
          >
            <bdi>{proposal.title}</bdi>
          </Link>
        ) : (
          <h3 className="break-words text-body font-semibold text-fg">
            <bdi>{proposal.title}</bdi>
          </h3>
        )}
        <span className="text-helper font-semibold text-fg" data-testid="chore-proposal-status">
          {t(statusKey[proposal.status])}
          {proposal.status === "approved" && proposal.revised ? ` ${t("proposalRevised")}` : ""}
        </span>
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-helper text-fg-muted">
        {proposal.category ? (
          <LabelChip name={proposal.category.name} color={proposal.category.color} />
        ) : (
          <span>{t("uncategorized")}</span>
        )}
        <span>{t("dueOn", { date: formatTaskDate(proposal.dueDate, formats) })}</span>
        <span>
          {proposal.minutes === null ? t("noEstimate") : t("minutes", { count: proposal.minutes })}
        </span>
        {proposal.steps.length > 0 ? (
          <span>{t("proposalStepCount", { count: proposal.steps.length })}</span>
        ) : null}
        {proposal.possibleDuplicate ? (
          <span className="font-semibold text-fg" data-testid="chore-proposal-duplicate">
            {t("proposalPossibleDuplicate")}
          </span>
        ) : null}
      </p>
      <p className="text-helper text-fg-muted">
        {t("proposalBy", {
          person: who(proposal.by),
          date: formatDateTime(proposal.createdAt, formats),
        })}
        {proposal.decidedAt
          ? ` ${t("proposalDecidedBy", {
              person: who(proposal.decidedBy),
              date: formatDateTime(proposal.decidedAt, formats),
            })}`
          : ""}
      </p>
      {proposal.instructions ? (
        <p className="whitespace-pre-wrap break-words text-body text-fg">{proposal.instructions}</p>
      ) : null}
      {proposal.steps.length > 0 ? (
        <ul className="ms-5 list-disc text-body text-fg">
          {proposal.steps.map((step, index) => (
            <li key={index} className="break-words">
              <bdi>{step.label}</bdi>
              {step.mandatory ? ` ${t("proposalStepRequired")}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {proposal.feedback ? (
        <p className="text-body text-fg">
          <span className="font-medium">{t("proposalFeedback")}</span>{" "}
          <span className="break-words">{proposal.feedback}</span>
        </p>
      ) : null}
      {proposal.canReview || proposal.canWithdraw ? (
        <ProposalActions proposal={proposal} categories={active} today={today} formats={formats} />
      ) : null}
    </li>
  );

  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-8">
        <p className="text-body text-fg-muted">
          {list.value.canReview ? t("proposalsIntroManager") : t("proposalsIntro")}
        </p>
        <ProposeChore homeId={home.id} categories={active} today={today} />
        <section aria-labelledby="proposals-waiting-heading" className="flex flex-col gap-3">
          <h2 id="proposals-waiting-heading" className="text-section-title font-semibold text-fg">
            {t("proposalsWaiting")}
          </h2>
          {waiting.length === 0 ? (
            <EmptyState title={t("proposalsEmptyTitle")} description={t("proposalsEmpty")} />
          ) : (
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="chore-proposals-waiting"
            >
              {waiting.map(item)}
            </ul>
          )}
        </section>
        {decided.length > 0 ? (
          <section aria-labelledby="proposals-decided-heading" className="flex flex-col gap-3">
            <h2 id="proposals-decided-heading" className="text-section-title font-semibold text-fg">
              {t("proposalsDecided")}
            </h2>
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="chore-proposals-decided"
            >
              {decided.map(item)}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}
