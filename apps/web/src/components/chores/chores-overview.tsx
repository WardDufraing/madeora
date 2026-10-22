import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { LabelChip } from "@/components/tasks/label-chip";
import { EmptyState, ErrorState } from "@/components/ui/states";
import type { ChoreOccurrenceRow } from "@/chores/api";
import {
  advanceChores,
  getChoreContext,
  getChorePool,
  getChorePoolVersion,
  getChoreSettings,
  listChoreCategories,
  listChoreOccurrences,
  listChoreProposals,
  listChoreTemplates,
  listReassignmentRequests,
  listVolunteerOffers,
} from "@/chores/data";
import { choresPath } from "@/chores/format";
import { parseOverviewQuery, parsePoolWeek } from "@/chores/schema";
import { addDays, startOfWeek } from "@/tasks/calendar";
import { getDateTimeFormats } from "@/invitations/server";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate, memberNames, personName } from "@/tasks/format";
import { getVacationWidget } from "@/vacations/data";
import { absencesPath, vacationsPath } from "@/vacations/format";

import { ChoreBulk } from "./chore-bulk";
import { ChoreFilters } from "./chore-filters";
import { ChorePool } from "./chore-pool";
import { ChorePoolLive } from "./chore-pool-live";
import { ChoreRequests } from "./chore-requests";
import { VolunteerOffers } from "./chore-volunteers";
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

/** The address of the overview with the pool showing the week of `date` (null: this week). */
function poolWeekHref(
  base: string,
  searchParams: ChoresOverviewProps["searchParams"],
  date: string | null,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "poolWeek" || key === "deleted" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  if (date !== null) params.set("poolWeek", date);
  const search = params.toString();
  return search === "" ? base : `${base}?${search}`;
}

/**
 * A Home's chores (S20): its open occurrences grouped Needs reassignment, Overdue, Today and the
 * next days, with filters, and adding a chore or changing several at once for chore managers. Above
 * them (S21) the reassignment requests waiting for the viewer and the pool of unassigned chores to
 * claim, kept current live. Everything is read with the viewer's session; the controls shown follow
 * their rights, which the database checks again.
 */
export async function ChoresOverview({ home, searchParams, notice }: ChoresOverviewProps) {
  const query = parseOverviewQuery(searchParams);
  const poolWeek = parsePoolWeek(searchParams);
  // Recurring chores create their due occurrences, and due expiries and automatic releases are
  // applied, before anything is read (lazy generation). The signal version is read first, so a
  // change made while the page renders is caught by the live view.
  await advanceChores(home.id);
  const version = await getChorePoolVersion(home.id);
  const [
    t,
    formats,
    context,
    categories,
    members,
    page,
    templates,
    pool,
    settings,
    requests,
    proposals,
    offers,
    vacation,
  ] = await Promise.all([
    getTranslations("Chores"),
    getDateTimeFormats(),
    getChoreContext(home.id),
    listChoreCategories(home.id, true),
    listTaskMembers(home.id),
    listChoreOccurrences(home.id, query),
    // Managers only (anyone else gets none); a failure only hides the template choice.
    listChoreTemplates(home.id, false),
    getChorePool(home.id, poolWeek),
    getChoreSettings(home.id),
    listReassignmentRequests(home.id),
    // S21: the proposal count for managers and the viewer's volunteer invitations; a failure
    // only hides them.
    listChoreProposals(home.id),
    listVolunteerOffers(home.id),
    // S22: whether a Home vacation pauses chores today; a failure only hides the notice.
    getVacationWidget(home.id),
  ]);
  if (
    context.status !== "ok" ||
    categories.status !== "ok" ||
    members.status !== "ok" ||
    page.status !== "ok" ||
    pool.status !== "ok" ||
    settings.status !== "ok"
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
  const today = context.value.today;
  const currentWeek = startOfWeek(today, settings.value.weekStart);
  const shownWeek = startOfWeek(poolWeek ?? today, settings.value.weekStart);
  // Claimable chores show in the pool; the groups below keep everything else.
  const inPool = new Set(pool.value.rows.map((row) => row.id));
  const listed = page.value.occurrences.filter((row) => !inPool.has(row.id));
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
        <Link
          href={`${base}/proposals`}
          className="font-medium text-accent-fg underline"
          data-testid="chores-proposals-link"
        >
          {proposals.status === "ok" && proposals.value.pendingCount !== null
            ? t("proposalsLink", { count: proposals.value.pendingCount })
            : t("proposeLink")}
        </Link>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link
          href={`${base}/calendar`}
          className="font-medium text-accent-fg underline"
          data-testid="chores-calendar-link"
        >
          {t("calendarLink")}
        </Link>
        {context.value.canManage ? (
          <>
            <span aria-hidden="true">{"\u{00B7}"}</span>
            <Link
              href={`${base}/summary`}
              className="font-medium text-accent-fg underline"
              data-testid="chores-summary-link"
            >
              {t("summaryLink")}
            </Link>
          </>
        ) : null}
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`${base}/history`} className="font-medium text-accent-fg underline">
          {t("homeHistoryLink")}
        </Link>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link
          href={vacationsPath(home.id)}
          className="font-medium text-accent-fg underline"
          data-testid="chores-vacations-link"
        >
          {t("vacationsLink")}
        </Link>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link
          href={absencesPath(home.id)}
          className="font-medium text-accent-fg underline"
          data-testid="chores-absences-link"
        >
          {t("absencesLink")}
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
      {vacation.status === "ok" && vacation.value.pausedToday ? (
        <p
          role="status"
          className="mb-4 rounded-card border border-line bg-surface-sunken p-3 text-body text-fg"
          data-testid="chores-paused-today"
        >
          {t("pausedTodayNotice")}{" "}
          <Link href={vacationsPath(home.id)} className="font-medium text-accent-fg underline">
            {t("openVacations")}
          </Link>
        </p>
      ) : null}
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
      <ChorePoolLive homeId={home.id} version={version} />
      <div className="flex max-w-4xl flex-col gap-6">
        {offers.status === "ok" && offers.value.length > 0 ? (
          <VolunteerOffers homeId={home.id} offers={offers.value} formats={formats} />
        ) : null}
        {requests.status === "ok" && requests.value.length > 0 ? (
          <ChoreRequests
            homeId={home.id}
            requests={requests.value}
            members={members.value}
            formats={formats}
          />
        ) : null}
        <ChorePool
          homeId={home.id}
          pool={pool.value}
          week={{
            start: shownWeek,
            current: shownWeek === currentWeek,
            previousHref: poolWeekHref(base, searchParams, addDays(shownWeek, -7)),
            nextHref: poolWeekHref(base, searchParams, addDays(shownWeek, 7)),
            currentHref: poolWeekHref(base, searchParams, null),
          }}
          today={today}
          categories={categories.value.map(({ id, name }) => ({ id, name }))}
          formats={formats}
        />
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
        {listed.length === 0 ? (
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
            const rows = listed.filter((row) => groupOf(row) === group.id);
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
