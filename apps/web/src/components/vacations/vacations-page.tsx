import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, ErrorState } from "@/components/ui/states";
import type { ChorePerson } from "@/chores/api";
import { choresPath } from "@/chores/format";
import { getDateTimeFormats } from "@/invitations/server";
import { listTaskMembers } from "@/tasks/data";
import { memberNames, personName, type MemberNames } from "@/tasks/format";
import type { VacationSummary } from "@/vacations/api";
import { listHomeVacations } from "@/vacations/data";
import { absencesPath, rangeText, vacationsPath } from "@/vacations/format";

import { InvitationActions, ProposalAnswerActions } from "./invitation-actions";
import { NewVacation } from "./new-vacation";

/** A person's shown name on server pages. */
export async function serverPerson(names: MemberNames) {
  const t = await getTranslations("Chores");
  return (person: ChorePerson | null) => {
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
}

/**
 * A Home's vacations (S22; spec "Home vacations"): the caller's pending invitations and date
 * proposals first, then active and upcoming vacations with their dates, scope and whether chores are
 * paused, and the history. Every member records their own vacation here; chore managers record
 * vacations for anyone.
 */
export async function VacationsPage({
  home,
}: {
  readonly home: { readonly id: string; readonly name: string };
}) {
  const [t, formats, list, members] = await Promise.all([
    getTranslations("Vacations"),
    getDateTimeFormats(),
    listHomeVacations(home.id),
    listTaskMembers(home.id),
  ]);
  const header = (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={choresPath(home.id)} className="font-medium text-accent-fg underline">
          {t("backToChores")}
        </Link>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={absencesPath(home.id)} className="font-medium text-accent-fg underline">
          {t("absencesLink")}
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
  const name = (value: string | null) => value ?? t("genericName");
  const base = vacationsPath(home.id);
  const value = list.value;

  const item = (vacation: VacationSummary) => (
    <li key={vacation.id} className="flex flex-col gap-1 p-4" data-testid="vacation-item">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          href={`${base}/${vacation.id}`}
          className="text-body font-semibold text-fg underline-offset-2 hover:underline"
        >
          <bdi>{name(vacation.name)}</bdi>
        </Link>
        <span className="text-helper font-semibold text-fg" data-testid="vacation-status">
          {t(`status_${vacation.status}`)}
        </span>
      </div>
      <p className="flex flex-wrap gap-x-3 text-helper text-fg-muted">
        <span>{rangeText(vacation.startsOn, vacation.endsOn, formats)}</span>
        <span>
          {vacation.participants.length === 0
            ? t("scopeNobody")
            : vacation.participants.length >= vacation.memberCount
              ? t("scopeEveryone")
              : t("scopeMembers", {
                  names: vacation.participants.map((stay) => who(stay.member)).join(", "),
                })}
        </span>
        {vacation.pauseDates.length > 0 ? (
          <span className="font-semibold text-fg">{t("choresPaused")}</span>
        ) : null}
      </p>
    </li>
  );

  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-8">
        <p className="text-body text-fg-muted">{t("intro")}</p>
        {value.pausedToday ? (
          <p
            role="status"
            className="rounded-card border border-line bg-surface-sunken p-3 text-body text-fg"
            data-testid="vacations-paused-today"
          >
            {t("pausedToday")}
          </p>
        ) : null}
        {value.invitations.length > 0 || value.proposals.length > 0 ? (
          <section aria-labelledby="vacation-requests-heading" className="flex flex-col gap-3">
            <h2 id="vacation-requests-heading" className="text-section-title font-semibold text-fg">
              {t("requestsHeading")}
            </h2>
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="vacation-requests"
            >
              {value.invitations.map((invitation) => (
                <li key={invitation.participantId} className="flex flex-col gap-2 p-4">
                  <p className="text-body text-fg">
                    {t("invitationText", {
                      person: who(invitation.invitedBy),
                      name: name(invitation.name),
                      dates: rangeText(invitation.startsOn, invitation.endsOn, formats),
                    })}{" "}
                    <Link
                      href={`${base}/${invitation.vacationId}`}
                      className="font-medium text-accent-fg underline"
                    >
                      {t("openVacation")}
                    </Link>
                  </p>
                  <p className="text-helper text-fg-muted">{t("invitationDeadline")}</p>
                  <InvitationActions
                    participantId={invitation.participantId}
                    revision={invitation.revision}
                    label={name(invitation.name)}
                    names={names}
                    formats={formats}
                  />
                </li>
              ))}
              {value.proposals.map((proposal) => (
                <li key={proposal.proposalId} className="flex flex-col gap-2 p-4">
                  <p className="text-body text-fg">
                    {t("proposalText", {
                      person: who(proposal.proposedBy),
                      name: name(proposal.name),
                      dates: rangeText(proposal.startsOn, proposal.endsOn, formats),
                      current: rangeText(proposal.currentStartsOn, proposal.currentEndsOn, formats),
                    })}
                  </p>
                  <ProposalAnswerActions
                    proposalId={proposal.proposalId}
                    label={name(proposal.name)}
                    names={names}
                    formats={formats}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <NewVacation
          homeId={home.id}
          members={members.value}
          today={value.today}
          canManage={value.canManage}
          formats={formats}
        />
        <section aria-labelledby="vacations-current-heading" className="flex flex-col gap-3">
          <h2 id="vacations-current-heading" className="text-section-title font-semibold text-fg">
            {t("currentHeading")}
          </h2>
          {value.current.length === 0 ? (
            <EmptyState title={t("emptyTitle")} description={t("empty")} />
          ) : (
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="vacations-current"
            >
              {value.current.map(item)}
            </ul>
          )}
        </section>
        {value.history.length > 0 ? (
          <section aria-labelledby="vacations-history-heading" className="flex flex-col gap-3">
            <h2 id="vacations-history-heading" className="text-section-title font-semibold text-fg">
              {t("historyHeading")}
            </h2>
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="vacations-history"
            >
              {value.history.map(item)}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}
