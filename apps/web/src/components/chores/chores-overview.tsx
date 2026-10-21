import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { LabelChip } from "@/components/tasks/label-chip";
import { EmptyState, ErrorState } from "@/components/ui/states";
import type { ChoreOccurrenceRow } from "@/chores/api";
import {
  advanceChores,
  getChoreContext,
  listChoreCategories,
  listChoreOccurrences,
  listChoreTemplates,
} from "@/chores/data";
import { choresPath } from "@/chores/format";
import { parseOverviewQuery } from "@/chores/schema";
import { getDateTimeFormats } from "@/invitations/server";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate, memberNames, personName } from "@/tasks/format";

import { ChoreBulk } from "./chore-bulk";
import { ChoreFilters } from "./chore-filters";
import { NewChore } from "./new-chore";
import { QuickComplete } from "./quick-complete";

export interface ChoresOverviewProps {
  readonly home: { readonly id: string; readonly name: string };
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
  /** A notice to show once, e.g. after a chore was moved to the trash. */
  readonly notice: "deleted" | null;
}

type Group = "pending" | "reassign" | "overdue" | "today" | "upcoming";

function groupOf(row: ChoreOccurrenceRow): Group {
  if (row.status === "pending_approval") return "pending";
  if (row.needsReassignment) return "reassign";
  if (row.overdue) return "overdue";
  return row.dueToday ? "today" : "upcoming";
}

/**
 * A Home's chores (S20): its open occurrences grouped Needs reassignment, Overdue, Today and the
 * next days, with filters, and adding a chore or changing several at once for chore managers. Everything is read with the
 * viewer's session; the controls shown follow their rights, which the database checks again.
 */
export async function ChoresOverview({ home, searchParams, notice }: ChoresOverviewProps) {
  const query = parseOverviewQuery(searchParams);
  // Recurring chores create their due occurrences before anything is read (lazy generation).
  await advanceChores(home.id);
  const [t, formats, context, categories, members, page, templates] = await Promise.all([
    getTranslations("Chores"),
    getDateTimeFormats(),
    getChoreContext(home.id),
    listChoreCategories(home.id, true),
    listTaskMembers(home.id),
    listChoreOccurrences(home.id, query),
    // Managers only (anyone else gets none); a failure only hides the template choice.
    listChoreTemplates(home.id, false),
  ]);
  if (
    context.status !== "ok" ||
    categories.status !== "ok" ||
    members.status !== "ok" ||
    page.status !== "ok"
  ) {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const base = choresPath(home.id);
  const names = memberNames(members.value);
  const selfId = names.selfId;
  const who = (memberId: string) => {
    const name = personName({ me: false, member: memberId }, names);
    return name.kind === "me"
      ? t("personYou")
      : name.kind === "member"
        ? name.name
        : name.kind === "unnamed"
          ? t("personUnnamed")
          : t("personFormer");
  };
  const groups: readonly { readonly id: Group; readonly title: string }[] = [
    { id: "reassign", title: t("groupReassign") },
    { id: "pending", title: t("groupPending") },
    { id: "overdue", title: t("groupOverdue") },
    { id: "today", title: t("groupToday") },
    { id: "upcoming", title: t("groupUpcoming") },
  ];
  const filtered = query.assignee !== "any" || query.category !== "any";
  const activeCategories = categories.value.filter((category) => !category.archived);

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        {context.value.canReview ? (
          <>
            <span aria-hidden="true">{"\u{00B7}"}</span>
            <Link
              href={`${base}/approvals`}
              className="font-medium text-accent-fg underline"
              data-testid="chores-approvals-link"
            >
              {t("approvalsLink", { count: context.value.pendingCount })}
            </Link>
          </>
        ) : null}
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`${base}/history`} className="font-medium text-accent-fg underline">
          {t("homeHistoryLink")}
        </Link>
        {context.value.canManage ? (
          <>
            <span aria-hidden="true">{"\u{00B7}"}</span>
            <Link href={`${base}/manage`} className="font-medium text-accent-fg underline">
              {t("manageLink")}
            </Link>
          </>
        ) : null}
      </p>
      {notice === "deleted" ? (
        <p
          role="status"
          className="mb-4 rounded-card border border-line bg-surface-sunken p-3 text-body text-fg"
        >
          {t("deletedNotice")}{" "}
          <Link href={`/homes/${home.id}/trash`} className="font-medium text-accent-fg underline">
            {t("openTrash")}
          </Link>
        </p>
      ) : null}
      <div className="flex max-w-4xl flex-col gap-6">
        {context.value.canManage ? (
          <NewChore
            homeId={home.id}
            categories={activeCategories.map(({ id, name }) => ({ id, name }))}
            members={members.value}
            today={context.value.today}
            dateFormat={formats.dateFormat}
            templates={templates.status === "ok" ? templates.value : []}
          />
        ) : null}
        {context.value.canManage ? (
          <ChoreBulk
            homeId={home.id}
            rows={page.value.occurrences.map((row) => ({
              id: row.id,
              title: row.title,
              dueDate: row.dueDate,
              revision: row.revision,
              pending: row.status === "pending_approval",
            }))}
            members={members.value}
            today={context.value.today}
            dateFormat={formats.dateFormat}
          />
        ) : null}
        <ChoreFilters
          action={base}
          query={query}
          members={members.value}
          categories={categories.value.map(({ id, name }) => ({ id, name }))}
          filtered={filtered}
        />
        {page.value.occurrences.length === 0 ? (
          <EmptyState
            title={filtered ? t("emptyFilteredTitle") : t("emptyTitle")}
            description={
              filtered
                ? t("emptyFiltered")
                : context.value.canManage
                  ? t("emptyManager")
                  : t("emptyMember")
            }
          />
        ) : (
          groups.map((group) => {
            const rows = page.value.occurrences.filter((row) => groupOf(row) === group.id);
            if (rows.length === 0) return null;
            return (
              <section
                key={group.id}
                aria-labelledby={`chores-${group.id}`}
                className="flex flex-col gap-2"
                data-testid={`chores-group-${group.id}`}
              >
                <h2 id={`chores-${group.id}`} className="text-section-title font-semibold text-fg">
                  {group.title}{" "}
                  <span className="text-body font-normal text-fg-muted">
                    {t("groupCount", { count: rows.length })}
                  </span>
                </h2>
                <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
                  {rows.map((row) => {
                    // Quick complete only where nothing needs a choice: no mandatory step open, and
                    // the viewer is the natural contributor (their chore, or nobody's).
                    const quick =
                      row.status === "open" &&
                      row.mandatoryOpen === 0 &&
                      selfId !== null &&
                      (row.assignedToMe || row.assigneeIds.length === 0);
                    return (
                      <li
                        key={row.id}
                        className="flex flex-wrap items-center justify-between gap-3 p-3"
                        data-testid="chore-row"
                      >
                        <div className="flex min-w-0 flex-col gap-1">
                          <Link
                            href={`${base}/${row.id}`}
                            className="text-body font-semibold text-fg underline-offset-2 hover:underline"
                          >
                            <bdi>{row.title}</bdi>
                          </Link>
                          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-helper text-fg-muted">
                            {row.category ? (
                              <LabelChip name={row.category.name} color={row.category.color} />
                            ) : (
                              <span>{t("uncategorized")}</span>
                            )}
                            <span className={row.overdue ? "font-semibold text-danger" : undefined}>
                              {row.overdue
                                ? t("overdueSince", {
                                    date: formatTaskDate(row.dueDate, formats),
                                  })
                                : t("dueOn", { date: formatTaskDate(row.dueDate, formats) })}
                            </span>
                            <span>
                              {row.assigneeIds.length === 0
                                ? t("unassigned")
                                : row.assigneeIds.map(who).join(", ")}
                            </span>
                            {row.stepsTotal > 0 ? (
                              <span>
                                {t("stepsProgress", { done: row.stepsDone, total: row.stepsTotal })}
                              </span>
                            ) : null}
                            {row.minutes !== null ? (
                              <span>{t("minutes", { count: row.minutes })}</span>
                            ) : null}
                            {row.kind === "recurring" ? <span>{t("repeats")}</span> : null}
                            {row.needsReassignment ? (
                              <span className="font-semibold text-fg">
                                {t("needsReassignment")}
                              </span>
                            ) : null}
                            {row.status === "pending_approval" ? (
                              <span className="font-semibold text-fg">{t("pendingMark")}</span>
                            ) : null}
                            {row.inRework ? (
                              <span className="font-semibold text-fg">{t("reworkMark")}</span>
                            ) : null}
                            {row.requiresApproval && row.status === "open" ? (
                              <span>{t("approvalMark")}</span>
                            ) : null}
                          </p>
                        </div>
                        {quick && selfId ? (
                          <QuickComplete
                            occurrenceId={row.id}
                            title={row.title}
                            contributor={selfId}
                            requiresApproval={row.requiresApproval}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </>
  );
}
