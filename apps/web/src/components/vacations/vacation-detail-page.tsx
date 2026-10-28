import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { VacationHabitsSection } from "@/components/habits/vacation-habits";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { formatDateTime } from "@/invitations/format";
import { readVacationHabits } from "@/habits/data";
import { getDateTimeFormats } from "@/invitations/server";
import { listTaskMembers } from "@/tasks/data";
import { memberNames } from "@/tasks/format";
import type { VacationEvent, VacationPerson } from "@/vacations/api";
import { getHomeVacation, listVacationReview } from "@/vacations/data";
import { rangeText, rangesText, vacationsPath } from "@/vacations/format";

import { ReviewList } from "./review-list";
import { AddParticipants, ParticipantActions, VacationActions } from "./vacation-actions";
import { serverPerson } from "./vacations-page";

/**
 * One Home vacation (S22): its status, overall dates, the people with their own dates and states,
 * the actions the viewer may take, the Home-wide chore pause, the affected chores with decisions,
 * the viewer's own personal habit pauses (S28), and (chore managers and the creator) its history.
 */
export async function VacationDetailPage({
  home,
  vacationId,
}: {
  readonly home: { readonly id: string; readonly name: string };
  readonly vacationId: string;
}) {
  const [t, formats, vacation, review, members, habits] = await Promise.all([
    getTranslations("Vacations"),
    getDateTimeFormats(),
    getHomeVacation(vacationId),
    listVacationReview(vacationId),
    listTaskMembers(home.id),
    readVacationHabits(vacationId),
  ]);
  const back = (
    <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
      <bdi className="font-semibold text-fg">{home.name}</bdi>
      <span aria-hidden="true">{"\u{00B7}"}</span>
      <Link href={vacationsPath(home.id)} className="font-medium text-accent-fg underline">
        {t("backToVacations")}
      </Link>
    </p>
  );
  if (
    vacation.status === "not-found" ||
    (vacation.status === "ok" && vacation.value.homeId !== home.id)
  ) {
    return (
      <>
        <PageHeader title={t("detailTitle")} />
        {back}
        <ErrorState title={t("notFoundTitle")} description={t("notFound")} />
      </>
    );
  }
  if (vacation.status !== "ok" || review.status !== "ok" || members.status !== "ok") {
    return (
      <>
        <PageHeader title={t("detailTitle")} />
        {back}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  const value = vacation.value;
  const names = memberNames(members.value);
  const who = await serverPerson(names);
  const title = value.name ?? t("genericName");
  const accepted = value.people.filter((person) => person.status === "accepted");
  const others = value.people.filter((person) => person.status !== "accepted");
  const statusOf = (person: VacationPerson) =>
    person.status === "withdrawn" && person.endedReason
      ? t(`ended_${person.endedReason}`)
      : t(`participant_${person.status}`);

  const personItem = (person: VacationPerson) => (
    <li key={person.id} className="flex flex-col gap-2 p-4" data-testid="vacation-person">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-body font-semibold text-fg">{who(person.member)}</span>
        <span className="text-helper font-semibold text-fg" data-testid="vacation-person-status">
          {statusOf(person)}
        </span>
      </div>
      <p className="flex flex-wrap gap-x-3 text-helper text-fg-muted">
        <span>{rangeText(person.startsOn, person.endsOn, formats)}</span>
        {person.status === "pending" ? (
          <span>{t("invitedBy", { person: who(person.invitedBy) })}</span>
        ) : null}
      </p>
      {person.proposal ? (
        <p className="text-helper text-fg" data-testid="vacation-person-proposal">
          {t("proposalWaiting", {
            person: who(person.proposal.proposedBy),
            dates: rangeText(person.proposal.startsOn, person.proposal.endsOn, formats),
          })}
        </p>
      ) : null}
      <ParticipantActions
        person={person}
        label={who(person.member)}
        members={members.value}
        formats={formats}
      />
    </li>
  );

  const eventLine = (event: VacationEvent) =>
    t(`event_${event.kind}`, {
      person: who(event.by),
      subject: who(event.subject),
      dates: event.startsOn && event.endsOn ? rangeText(event.startsOn, event.endsOn, formats) : "",
      date: formatDateTime(event.at, formats),
    });

  return (
    <>
      <PageHeader title={title} />
      {back}
      <div className="flex max-w-3xl flex-col gap-8">
        <section aria-labelledby="vacation-summary-heading" className="flex flex-col gap-3">
          <h2 id="vacation-summary-heading" className="sr-only">
            {t("summaryHeading")}
          </h2>
          <dl className="grid gap-x-4 gap-y-1 text-body sm:grid-cols-[max-content_1fr]">
            <dt className="font-medium text-fg">{t("statusLabel")}</dt>
            <dd className="text-fg" data-testid="vacation-detail-status">
              {t(`status_${value.status}`)}
            </dd>
            <dt className="font-medium text-fg">{t("datesLabel")}</dt>
            <dd className="text-fg">{rangeText(value.startsOn, value.endsOn, formats)}</dd>
            <dt className="font-medium text-fg">{t("createdByLabel")}</dt>
            <dd className="text-fg">{who(value.createdBy)}</dd>
            <dt className="font-medium text-fg">{t("pauseLabel")}</dt>
            <dd className="text-fg" data-testid="vacation-detail-pause">
              {value.homePause.effective.length > 0
                ? t("pauseOn", { dates: rangesText(value.homePause.effective, formats) })
                : t("pauseOff")}
            </dd>
            {value.reminderDays !== null || value.can.reminder ? (
              <>
                <dt className="font-medium text-fg">{t("reminderLabel")}</dt>
                <dd className="text-fg">
                  {value.reminderDays === null
                    ? t("reminderOff")
                    : t("reminderOn", { count: value.reminderDays })}
                </dd>
              </>
            ) : null}
          </dl>
          {value.status === "cancelled" && value.cancelledAt ? (
            <p className="text-body text-fg">
              {t("cancelledBy", {
                person: who(value.cancelledBy),
                date: formatDateTime(value.cancelledAt, formats),
              })}
            </p>
          ) : null}
          <VacationActions vacation={value} members={members.value} formats={formats} />
        </section>

        <section aria-labelledby="vacation-people-heading" className="flex flex-col gap-3">
          <h2 id="vacation-people-heading" className="text-section-title font-semibold text-fg">
            {t("peopleHeading")}
          </h2>
          {accepted.length === 0 ? (
            <p className="text-body text-fg-muted">{t("peopleEmpty")}</p>
          ) : (
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="vacation-people"
            >
              {accepted.map(personItem)}
            </ul>
          )}
          {others.length > 0 ? (
            <>
              <h3 className="text-body font-semibold text-fg">{t("othersHeading")}</h3>
              <ul
                className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
                data-testid="vacation-others"
              >
                {others.map(personItem)}
              </ul>
            </>
          ) : null}
          {value.can.invite ? (
            <div>
              <AddParticipants vacation={value} members={members.value} formats={formats} />
            </div>
          ) : null}
        </section>

        {value.status !== "cancelled" ? (
          <section aria-labelledby="vacation-review-heading" className="flex flex-col gap-3">
            <h2 id="vacation-review-heading" className="text-section-title font-semibold text-fg">
              {t("reviewHeading")}
            </h2>
            <p className="text-body text-fg-muted">
              {review.value.canDecide ? t("reviewIntroManager") : t("reviewIntro")}
            </p>
            <ReviewList
              homeId={home.id}
              source={{ kind: "vacation", id: value.id }}
              items={review.value.items}
              planned={review.value.planned}
              canDecide={review.value.canDecide}
              today={review.value.today}
              members={members.value}
              formats={formats}
            />
          </section>
        ) : null}

        {habits.status === "ok" ? (
          <VacationHabitsSection vacationId={value.id} value={habits.value} />
        ) : null}

        {value.history ? (
          <section aria-labelledby="vacation-history-heading" className="flex flex-col gap-3">
            <h2 id="vacation-history-heading" className="text-section-title font-semibold text-fg">
              {t("eventsHeading")}
            </h2>
            <ul className="flex flex-col gap-1 text-body text-fg" data-testid="vacation-events">
              {value.history.map((event, index) => (
                <li key={`${event.at}:${String(index)}`}>{eventLine(event)}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}
