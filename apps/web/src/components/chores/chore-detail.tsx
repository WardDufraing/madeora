import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { LabelChip } from "@/components/tasks/label-chip";
import { ErrorState } from "@/components/ui/states";
import {
  advanceChores,
  getChoreOccurrence,
  listChoreCategories,
  listChoreHistory,
} from "@/chores/data";
import { choresPath } from "@/chores/format";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate, memberNames, personName } from "@/tasks/format";

import { ChoreAttempts } from "./chore-attempts";
import { ChoreChecklist } from "./chore-checklist";
import { ChoreDelete } from "./chore-delete";
import { ChoreEdit } from "./chore-edit";
import { ChoreFieldsEdit } from "./chore-fields-edit";
import { ChoreHistory } from "./chore-history";
import { ChoreRepeats } from "./chore-repeats";
import { ChoreStatus } from "./chore-status";

export interface ChoreDetailPageProps {
  readonly userId: string;
  readonly homeId: string;
  readonly occurrenceId: string;
}

/**
 * One chore occurrence (S20): its status and record, checklist, details, schedule and the chore's
 * history. Every current member of the Home sees it and may complete it; chore managers also skip,
 * reopen, edit, pause and delete. An occurrence of another Home than the address is not found.
 */
export async function ChoreDetailPage({ userId, homeId, occurrenceId }: ChoreDetailPageProps) {
  await advanceChores(homeId);
  const [t, formats, occurrence] = await Promise.all([
    getTranslations("Chores"),
    getDateTimeFormats(),
    getChoreOccurrence(occurrenceId),
  ]);
  if (occurrence.status === "not-found") notFound();
  if (occurrence.status === "unavailable") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const detail = occurrence.value;
  if (detail.homeId !== homeId) notFound();
  const [members, categories, history] = await Promise.all([
    listTaskMembers(homeId),
    listChoreCategories(homeId, false),
    listChoreHistory(detail.chore.id, "all", 0),
  ]);
  if (members.status !== "ok" || categories.status !== "ok" || history.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const names = memberNames(members.value);
  const memberName = (memberId: string | null) => {
    if (memberId === null) return t("emptyPlace");
    const name = personName({ me: false, member: memberId }, names);
    return name.kind === "me"
      ? t("personYou")
      : name.kind === "member"
        ? name.name
        : name.kind === "unnamed"
          ? t("personUnnamed")
          : t("personFormer");
  };
  const base = choresPath(homeId);
  // Pending approval counts as closed here: it is not changed while a reviewer decides.
  const closed = detail.status !== "open";
  // A closed occurrence shows what it was closed under; an open one the chore as it is now.
  const title = closed && detail.closedTitle ? detail.closedTitle : detail.chore.title;
  const manage = detail.can.manage;
  const loadedAt = new Date().toISOString();

  return (
    <>
      <PageHeader title={title} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <Link href={base} className="font-medium text-accent-fg underline">
          {t("backToChores")}
        </Link>
        {manage ? (
          <>
            <span aria-hidden="true">{"\u{00B7}"}</span>
            <Link href={`${base}/manage`} className="font-medium text-accent-fg underline">
              {t("manageLink")}
            </Link>
          </>
        ) : null}
      </p>
      <div className="flex max-w-3xl flex-col gap-8">
        <ChoreStatus occurrence={detail} members={members.value} formats={formats} />
        <ChoreChecklist occurrence={detail} />
        <ChoreAttempts submissions={detail.submissions} members={members.value} formats={formats} />
        <section aria-labelledby="chore-details-heading" className="flex flex-col gap-3">
          <h2 id="chore-details-heading" className="text-section-title font-semibold text-fg">
            {t("detailsHeading")}
          </h2>
          <dl className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-[max-content_1fr]">
            <dt className="font-medium text-fg">{t("fieldDueDate")}</dt>
            <dd className={detail.overdue ? "font-semibold text-danger" : "text-fg"}>
              {detail.overdue
                ? t("overdueSince", { date: formatTaskDate(detail.dueDate, formats) })
                : formatTaskDate(detail.dueDate, formats)}
              {detail.dueDate !== detail.scheduledDate ? (
                <span className="ms-2 font-normal text-fg-muted">
                  {t("scheduledFor", { date: formatTaskDate(detail.scheduledDate, formats) })}
                </span>
              ) : null}
            </dd>
            <dt className="font-medium text-fg">{t("fieldCategory")}</dt>
            <dd className="text-fg">
              {closed ? (
                (detail.closedCategory ?? t("uncategorized"))
              ) : detail.chore.category ? (
                <LabelChip name={detail.chore.category.name} color={detail.chore.category.color} />
              ) : (
                t("uncategorized")
              )}
            </dd>
            <dt className="font-medium text-fg">{t("fieldAssignees")}</dt>
            <dd className="text-fg" data-testid="chore-assignees">
              {detail.assigneeIds.length === 0
                ? t("unassigned")
                : detail.assigneeIds.map(memberName).join(", ")}
              {detail.needsReassignment ? (
                <span className="ms-2 font-semibold">{t("needsReassignment")}</span>
              ) : null}
            </dd>
            <dt className="font-medium text-fg">{t("fieldMinutes")}</dt>
            <dd className="text-fg">
              {detail.minutes === null ? t("noEstimate") : t("minutes", { count: detail.minutes })}
            </dd>
            {detail.detached ? (
              <>
                <dt className="font-medium text-fg">{t("changedHeading")}</dt>
                <dd className="text-fg">{t("detachedNote")}</dd>
              </>
            ) : null}
          </dl>
          {detail.chore.instructions ? (
            <div className="flex flex-col gap-1">
              <h3 className="text-body font-semibold text-fg">{t("fieldInstructions")}</h3>
              <p className="whitespace-pre-wrap break-words text-body text-fg">
                {detail.chore.instructions}
              </p>
            </div>
          ) : null}
          {manage ? (
            <ChoreFieldsEdit
              chore={detail.chore}
              categories={categories.value.map(({ id, name }) => ({ id, name }))}
            />
          ) : null}
        </section>
        {detail.schedule ? (
          <ChoreRepeats
            choreId={detail.chore.id}
            schedule={detail.schedule}
            today={detail.today}
            manage={manage}
            memberNames={Object.fromEntries(
              [
                ...new Set([
                  ...detail.schedule.members,
                  ...detail.schedule.next.flatMap((n) => n.assigneeIds),
                ]),
              ].map((id) => [id ?? "", memberName(id)]),
            )}
            formats={formats}
          />
        ) : null}
        {manage && !closed ? (
          <ChoreEdit occurrence={detail} members={members.value} dateFormat={formats.dateFormat} />
        ) : null}
        {detail.events.length > 0 ? (
          <section aria-labelledby="chore-events-heading" className="flex flex-col gap-2">
            <h2 id="chore-events-heading" className="text-section-title font-semibold text-fg">
              {t("eventsHeading")}
            </h2>
            <ol className="flex flex-col gap-1 text-body text-fg" data-testid="chore-events">
              {detail.events.map((event, index) => {
                const who = (person: typeof event.by) =>
                  person
                    ? person.me
                      ? t("personYou")
                      : memberName(person.member)
                    : t("personFormer");
                const by = who(event.by);
                const contributor = who(event.contributor);
                const date = formatDateTime(event.at, formats);
                return (
                  <li key={index}>
                    {event.kind === "completed"
                      ? t("eventCompleted", { person: by, contributor, date })
                      : event.kind === "submitted"
                        ? t("eventSubmitted", { person: by, contributor, date })
                        : event.kind === "approved"
                          ? t("eventApproved", { person: by, date })
                          : event.kind === "rejected"
                            ? t("eventRejected", { person: by, date })
                            : event.kind === "withdrawn"
                              ? t("eventWithdrawn", { person: by, date })
                              : event.kind === "corrected"
                                ? t("eventCorrected", {
                                    person: by,
                                    date,
                                    before: who(event.previousContributor),
                                    after: contributor,
                                    beforeAt: event.previousCompletedAt
                                      ? formatDateTime(event.previousCompletedAt, formats)
                                      : "",
                                    afterAt: event.completedAt
                                      ? formatDateTime(event.completedAt, formats)
                                      : "",
                                  })
                                : event.kind === "skipped"
                                  ? t("eventSkipped", { person: by, date })
                                  : t("eventReopened", { person: by, date })}
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}
        <ChoreHistory
          userId={userId}
          homeId={homeId}
          choreId={detail.chore.id}
          initial={history.value}
          loadedAt={loadedAt}
          members={members.value}
          formats={formats}
        />
        {manage &&
        (detail.chore.kind === "one_off" || (!closed && !(detail.schedule?.ended ?? false))) ? (
          <ChoreDelete occurrence={detail} homeId={homeId} />
        ) : null}
      </div>
    </>
  );
}
