import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { choresPath } from "@/chores/format";
import { getDateTimeFormats } from "@/invitations/server";
import { listTaskMembers } from "@/tasks/data";
import { memberNames } from "@/tasks/format";
import { listAbsenceReview, listChoreAbsences } from "@/vacations/data";
import { absencesPath, rangeText, vacationsPath } from "@/vacations/format";

import { AbsenceActions, NewAbsence } from "./absence-forms";
import { ReviewList } from "./review-list";
import { serverPerson } from "./vacations-page";

/**
 * Temporary chore absences (S22; spec "temporary chore absence periods"): the caller's own and, for
 * chore managers, everyone's, with the private reason, the status and how many affected chores wait
 * for a decision. A planning signal only: nothing changes on its own.
 */
export async function AbsencesPage({
  home,
}: {
  readonly home: { readonly id: string; readonly name: string };
}) {
  const [t, formats, list, members] = await Promise.all([
    getTranslations("Vacations"),
    getDateTimeFormats(),
    listChoreAbsences(home.id),
    listTaskMembers(home.id),
  ]);
  const header = (
    <>
      <PageHeader title={t("absencesTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={choresPath(home.id)} className="font-medium text-accent-fg underline">
          {t("backToChores")}
        </Link>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={vacationsPath(home.id)} className="font-medium text-accent-fg underline">
          {t("vacationsLink")}
        </Link>
      </p>
    </>
  );
  if (list.status !== "ok" || members.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  const names = memberNames(members.value);
  const who = await serverPerson(names);
  const base = absencesPath(home.id);
  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-8">
        <p className="text-body text-fg-muted">
          {list.value.canManage ? t("absencesIntroManager") : t("absencesIntro")}
        </p>
        <NewAbsence
          homeId={home.id}
          members={members.value}
          today={list.value.today}
          canManage={list.value.canManage}
        />
        <section aria-labelledby="absences-heading" className="flex flex-col gap-3">
          <h2 id="absences-heading" className="text-section-title font-semibold text-fg">
            {t("absencesHeading")}
          </h2>
          {list.value.absences.length === 0 ? (
            <EmptyState title={t("absencesEmptyTitle")} description={t("absencesEmpty")} />
          ) : (
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="absences"
            >
              {list.value.absences.map((absence) => (
                <li key={absence.id} className="flex flex-col gap-2 p-4" data-testid="absence-item">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link
                      href={`${base}/${absence.id}`}
                      className="text-body font-semibold text-fg underline-offset-2 hover:underline"
                    >
                      {who(absence.member)}
                      {", "}
                      {rangeText(absence.startsOn, absence.endsOn, formats)}
                    </Link>
                    <span className="text-helper font-semibold text-fg">
                      {t(`absence_${absence.status}`)}
                    </span>
                  </div>
                  <p className="flex flex-wrap gap-x-3 text-helper text-fg-muted">
                    {absence.reason ? (
                      <span className="break-words">
                        {t("reasonLine", { reason: absence.reason })}
                      </span>
                    ) : null}
                    <span data-testid="absence-undecided">
                      {t("undecided", { count: absence.undecided })}
                    </span>
                  </p>
                  <AbsenceActions
                    homeId={home.id}
                    absence={absence}
                    label={who(absence.member)}
                    members={members.value}
                    formats={formats}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

/** One absence's affected chores (S22; its member and chore managers). */
export async function AbsenceReviewPage({
  home,
  absenceId,
}: {
  readonly home: { readonly id: string; readonly name: string };
  readonly absenceId: string;
}) {
  const [t, formats, review, members] = await Promise.all([
    getTranslations("Vacations"),
    getDateTimeFormats(),
    listAbsenceReview(absenceId),
    listTaskMembers(home.id),
  ]);
  const back = (
    <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
      <bdi className="font-semibold text-fg">{home.name}</bdi>
      <span aria-hidden="true">{"\u{00B7}"}</span>
      <Link href={absencesPath(home.id)} className="font-medium text-accent-fg underline">
        {t("backToAbsences")}
      </Link>
    </p>
  );
  if (
    review.status === "not-found" ||
    (review.status === "ok" && review.value.homeId !== home.id)
  ) {
    return (
      <>
        <PageHeader title={t("absenceTitle")} />
        {back}
        <ErrorState title={t("notFoundTitle")} description={t("absenceNotFound")} />
      </>
    );
  }
  if (review.status !== "ok" || members.status !== "ok") {
    return (
      <>
        <PageHeader title={t("absenceTitle")} />
        {back}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  const who = await serverPerson(memberNames(members.value));
  const value = review.value;
  return (
    <>
      <PageHeader title={t("absenceTitle")} />
      {back}
      <div className="flex max-w-3xl flex-col gap-6">
        <p className="text-body text-fg" data-testid="absence-summary">
          {who(value.member)}
          {", "}
          {rangeText(value.startsOn, value.endsOn, formats)}
          {value.reason ? ` \u{00B7} ${value.reason}` : ""}
        </p>
        <section aria-labelledby="absence-review-heading" className="flex flex-col gap-3">
          <h2 id="absence-review-heading" className="text-section-title font-semibold text-fg">
            {t("reviewHeading")}
          </h2>
          <p className="text-body text-fg-muted">
            {value.canDecide ? t("absenceReviewIntroManager") : t("absenceReviewIntro")}
          </p>
          <ReviewList
            homeId={home.id}
            source={{ kind: "absence", id: value.id }}
            items={value.items}
            planned={value.planned}
            canDecide={value.canDecide}
            today={value.today}
            members={members.value}
            formats={formats}
          />
        </section>
      </div>
    </>
  );
}
