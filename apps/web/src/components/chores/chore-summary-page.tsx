import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import type { ManagerSummaryGroup } from "@/chores/api";
import { advanceChores, getManagerSummary, getManagerSummarySetting } from "@/chores/data";
import { choresPath } from "@/chores/format";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate, memberNames, personName } from "@/tasks/format";
import { personalTimeZone } from "@/tasks/reminder-data";

import { ChoreSummarySetting } from "./chore-summary-setting";

const groups = [
  { id: "overdueUnassigned", title: "summaryOverdueUnassigned" },
  { id: "overdueAssigned", title: "summaryOverdueAssigned" },
  { id: "pendingReview", title: "summaryPendingReview" },
  { id: "inReview", title: "summaryInReview" },
  { id: "rework", title: "summaryRework" },
  { id: "releaseSoon", title: "summaryReleaseSoon" },
] as const satisfies readonly { id: ManagerSummaryGroup; title: string }[];

/**
 * A chore manager's daily summary of a Home (S21; spec "Confirmed chore manager daily summary"), as
 * it stands now: overdue chores with and without someone, submissions waiting for review, those in
 * review or rework, and claimed chores released back to the pool soon. Below it the manager turns
 * the once-a-day notification of it on or off. Anyone else is told it is for chore managers.
 */
export async function ChoreSummaryPage({
  home,
}: {
  readonly home: { readonly id: string; readonly name: string };
}) {
  await advanceChores(home.id);
  const [t, formats, summary, setting, members, timeZone] = await Promise.all([
    getTranslations("Chores"),
    getDateTimeFormats(),
    getManagerSummary(home.id),
    getManagerSummarySetting(home.id),
    listTaskMembers(home.id),
    personalTimeZone(),
  ]);
  const base = choresPath(home.id);
  const header = (
    <>
      <PageHeader title={t("summaryTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={base} className="font-medium text-accent-fg underline">
          {t("backToChores")}
        </Link>
      </p>
    </>
  );
  if (summary.status !== "ok" || setting.status !== "ok" || members.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={t("summaryLoadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  if (!summary.value) {
    return (
      <>
        {header}
        <p className="text-body text-fg-muted" data-testid="chore-summary-not-manager">
          {t("summaryManagersOnly")}
        </p>
      </>
    );
  }
  const names = memberNames(members.value);
  const who = (ids: readonly (string | null)[]) =>
    ids.length === 0
      ? t("unassigned")
      : ids
          .map((id) => {
            if (id === null) return t("personFormer");
            const name = personName({ me: false, member: id }, names);
            return name.kind === "me"
              ? t("personYou")
              : name.kind === "member"
                ? name.name
                : name.kind === "unnamed"
                  ? t("personUnnamed")
                  : t("personFormer");
          })
          .join(", ");
  const { counts, items } = summary.value;
  const total = groups.reduce((sum, group) => sum + counts[group.id], 0);

  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        <p className="text-body text-fg" data-testid="chore-summary-total">
          {total === 0 ? t("summaryAllClear") : t("summaryIntro", { count: total })}
        </p>
        {groups.map((group) => {
          const count = counts[group.id];
          if (count === 0) return null;
          const rows = items.filter((item) => item.group === group.id);
          const headingId = `chore-summary-${group.id}`;
          return (
            <section
              key={group.id}
              aria-labelledby={headingId}
              className="flex flex-col gap-2"
              data-testid="chore-summary-group"
              data-group={group.id}
            >
              <h2 id={headingId} className="text-section-title font-semibold text-fg">
                {t(group.title)} <span className="text-fg-muted">({count})</span>
              </h2>
              <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
                {rows.map((item) => (
                  <li key={item.id} className="flex flex-col gap-1 p-3">
                    <Link
                      href={`${base}/${item.id}`}
                      className="text-body font-semibold text-fg underline-offset-2 hover:underline"
                    >
                      <bdi>{item.title}</bdi>
                    </Link>
                    <p className="flex flex-wrap gap-x-3 gap-y-1 text-helper text-fg-muted">
                      <span>
                        {t("summaryDue", { date: formatTaskDate(item.dueDate, formats) })}
                      </span>
                      <span>{who(item.assigneeIds)}</span>
                      {item.releaseAt ? (
                        <span>
                          {t("summaryReleaseAt", { date: formatDateTime(item.releaseAt, formats) })}
                        </span>
                      ) : null}
                    </p>
                  </li>
                ))}
              </ul>
              {count > rows.length ? (
                <p className="text-helper text-fg-muted">
                  {t("summaryMore", { count: count - rows.length })}
                </p>
              ) : null}
            </section>
          );
        })}
        <ChoreSummarySetting homeId={home.id} setting={setting.value} timeZone={timeZone} />
      </div>
    </>
  );
}
