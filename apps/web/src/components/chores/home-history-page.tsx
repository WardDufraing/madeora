import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { TextField } from "@/components/ui/text-field";
import { listChores, listHomeChoreHistory } from "@/chores/data";
import { choresPath } from "@/chores/format";
import {
  CHORE_LIMITS,
  homeHistoryApprovals,
  homeHistorySearch,
  homeHistoryStates,
  isDefaultHistoryQuery,
  parseHomeHistoryQuery,
  type HomeHistoryApproval,
  type HomeHistoryQuery,
  type HomeHistoryState,
} from "@/chores/schema";
import { getDateTimeFormats } from "@/invitations/server";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate } from "@/tasks/format";

import { HomeHistoryList } from "./home-history-list";

const stateKey = {
  all: "historyStateAll",
  open: "historyStateOpen",
  due_today: "historyStateToday",
  missed: "historyStateMissed",
  rework: "historyStateRework",
  pending_approval: "historyStatePending",
  completed: "historyStateCompleted",
  skipped: "historyStateSkipped",
} as const satisfies Record<HomeHistoryState, string>;

const approvalKey = {
  any: "historyApprovalAny",
  pending: "historyApprovalPending",
  approved: "historyApprovalApproved",
  rejected: "historyApprovalRejected",
  none: "historyApprovalNone",
} as const satisfies Record<HomeHistoryApproval, string>;

export interface HomeHistoryPageProps {
  readonly userId: string;
  readonly home: { readonly id: string; readonly name: string; readonly timeZone: string };
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * A Home's chore history (S20; spec "Confirmed searchable Home-wide chore completion history"):
 * every occurrence of this Home only, newest first, searchable by chore name, note and skip reason,
 * with combinable filters for member, chore, a date range (scheduled date by default, or the
 * completion date; in the Home's timezone), state and approval. Each active filter is a chip that
 * removes it; Clear resets all. A plain GET form, so the filters live in the address bar and work
 * without JavaScript. Read-only: actions stay on the occurrence page.
 */
export async function HomeHistoryPage({ userId, home, searchParams }: HomeHistoryPageProps) {
  const query = parseHomeHistoryQuery(searchParams);
  const [t, formats, members, active, ended, page] = await Promise.all([
    getTranslations("Chores"),
    getDateTimeFormats(),
    listTaskMembers(home.id),
    listChores(home.id, false),
    listChores(home.id, true),
    listHomeChoreHistory(home.id, query, 0),
  ]);
  const base = choresPath(home.id);
  const action = `${base}/history`;
  const header = (
    <>
      <PageHeader title={t("homeHistoryTitle")} />
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
    members.status !== "ok" ||
    active.status !== "ok" ||
    ended.status !== "ok" ||
    page.status !== "ok"
  ) {
    return (
      <>
        {header}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  const chores = [...active.value, ...ended.value].sort((a, b) =>
    a.title.localeCompare(b.title, formats.locale),
  );
  const memberLabel = (id: string) => {
    const member = members.value.find((option) => option.id === id);
    if (!member) return t("personFormer");
    return member.isSelf ? t("personYou") : (member.name ?? t("personUnnamed"));
  };
  const without = (change: Partial<HomeHistoryQuery>) => {
    const search = homeHistorySearch({ ...query, ...change });
    return search ? `${action}?${search}` : action;
  };
  const chips: { readonly label: string; readonly href: string }[] = [];
  if (query.q !== "")
    chips.push({ label: t("chipSearch", { q: query.q }), href: without({ q: "" }) });
  if (query.member) {
    chips.push({
      label: t("chipMember", { name: memberLabel(query.member) }),
      href: without({ member: undefined }),
    });
  }
  if (query.chore) {
    const chore = chores.find((entry) => entry.id === query.chore);
    chips.push({
      label: t("chipChore", { title: chore?.title ?? t("chipChoreUnknown") }),
      href: without({ chore: undefined }),
    });
  }
  if (query.from || query.to) {
    const dates = {
      from: query.from ? formatTaskDate(query.from, formats) : "",
      to: query.to ? formatTaskDate(query.to, formats) : "",
    };
    chips.push({
      label:
        query.basis === "completed"
          ? query.from && query.to
            ? t("chipCompletedBetween", dates)
            : query.from
              ? t("chipCompletedFrom", dates)
              : t("chipCompletedUntil", dates)
          : query.from && query.to
            ? t("chipScheduledBetween", dates)
            : query.from
              ? t("chipScheduledFrom", dates)
              : t("chipScheduledUntil", dates),
      href: without({ from: undefined, to: undefined }),
    });
  } else if (query.basis === "completed") {
    chips.push({ label: t("chipCompletedOnly"), href: without({ basis: "scheduled" }) });
  }
  if (query.state !== "all") {
    chips.push({ label: t(stateKey[query.state]), href: without({ state: "all" }) });
  }
  if (query.approval !== "any") {
    chips.push({ label: t(approvalKey[query.approval]), href: without({ approval: "any" }) });
  }
  const filtered = !isDefaultHistoryQuery(query);

  return (
    <>
      {header}
      <div className="flex max-w-4xl flex-col gap-4">
        <form
          method="get"
          action={action}
          role="search"
          className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
          aria-label={t("homeHistoryFilters")}
          data-testid="home-history-filters"
        >
          <TextField
            type="search"
            name="q"
            label={t("historySearch")}
            description={t("historySearchHelp")}
            defaultValue={query.q}
            maxLength={CHORE_LIMITS.search}
            autoComplete="off"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label={t("historyMember")}
              name="member"
              defaultValue={query.member ?? ""}
              options={[
                { value: "", label: t("historyMemberAny") },
                ...members.value.map((member) => ({
                  value: member.id,
                  label: memberLabel(member.id),
                })),
              ]}
            />
            <SelectField
              label={t("historyChore")}
              name="chore"
              defaultValue={query.chore ?? ""}
              options={[
                { value: "", label: t("historyChoreAny") },
                ...chores.map((chore) => ({ value: chore.id, label: chore.title })),
              ]}
            />
            <SelectField
              label={t("historyState")}
              name="state"
              defaultValue={query.state}
              options={homeHistoryStates.map((value) => ({ value, label: t(stateKey[value]) }))}
            />
            <SelectField
              label={t("historyApproval")}
              name="approval"
              defaultValue={query.approval}
              options={homeHistoryApprovals.map((value) => ({
                value,
                label: t(approvalKey[value]),
              }))}
            />
          </div>
          <fieldset className="flex flex-col gap-3">
            <legend className="text-body font-medium text-fg">{t("historyDates")}</legend>
            <p className="text-helper text-fg-muted">
              {t("historyDatesHelp", { zone: home.timeZone })}
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <SelectField
                label={t("historyBasis")}
                name="basis"
                defaultValue={query.basis}
                options={[
                  { value: "scheduled", label: t("historyBasisScheduled") },
                  { value: "completed", label: t("historyBasisCompleted") },
                ]}
              />
              <TextField
                type="date"
                name="from"
                label={t("historyFrom")}
                defaultValue={query.from ?? ""}
              />
              <TextField
                type="date"
                name="to"
                label={t("historyTo")}
                defaultValue={query.to ?? ""}
              />
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary">
              {t("applyFilters")}
            </Button>
            {filtered ? (
              <Link href={action} className="text-body font-medium text-accent-fg underline">
                {t("clearFilters")}
              </Link>
            ) : null}
          </div>
        </form>
        {chips.length > 0 ? (
          <ul
            className="flex flex-wrap gap-2"
            aria-label={t("activeFilters")}
            data-testid="history-chips"
          >
            {chips.map((chip) => (
              <li key={chip.href + chip.label}>
                <Link
                  href={chip.href}
                  className="inline-flex min-h-6 items-center gap-1 rounded-full border border-line bg-surface-sunken px-3 py-1 text-helper text-fg underline-offset-2 hover:underline"
                  aria-label={t("removeFilter", { filter: chip.label })}
                >
                  <span>{chip.label}</span>
                  <span aria-hidden="true">{"\u{00D7}"}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-helper text-fg-muted" role="status">
          {t("homeHistoryCount", { count: page.value.total })}{" "}
          {query.basis === "completed" ? t("historySortCompleted") : t("historySortScheduled")}
        </p>
        {page.value.rows.length === 0 ? (
          <EmptyState
            title={filtered ? t("homeHistoryNoResultsTitle") : t("homeHistoryEmptyTitle")}
            description={filtered ? t("homeHistoryNoResults") : t("homeHistoryEmpty")}
          />
        ) : (
          <HomeHistoryList
            key={homeHistorySearch(query)}
            userId={userId}
            homeId={home.id}
            initial={page.value}
            loadedAt={new Date().toISOString()}
            members={members.value}
            formats={formats}
          />
        )}
      </div>
    </>
  );
}
