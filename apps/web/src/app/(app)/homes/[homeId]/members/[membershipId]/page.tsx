import { memberPermissions } from "@madeora/domain/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { HOME_UNAVAILABLE_PATH, isolatedName, loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { MemberAvatar } from "@/components/members/member-avatar";
import { CapabilitiesForm } from "@/components/members/manage/capabilities-form";
import { MemberRoleForm } from "@/components/members/manage/member-role-form";
import { NominateOwner } from "@/components/members/manage/nominate-owner";
import { RemoveMember } from "@/components/members/manage/remove-member";
import { CalendarAccessForm } from "@/components/calendar/calendar-access-form";
import { MedicalAccessForm } from "@/components/pets/medical-access-form";
import { HomeExportAccessForm } from "@/components/privacy/home-export-access-form";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getHomeDirectory } from "@/members/directory";
import { getCapabilityGrants, getOwnershipTransfer } from "@/members/manage-server";
import { readMedicalAccess } from "@/pets/data";
import { readCalendarAccess } from "@/calendar/data";
import { getHomeExportAccess } from "@/privacy/server";

interface MemberPageProps {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

export async function generateMetadata({ params }: MemberPageProps): Promise<Metadata> {
  const { homeId, membershipId } = await params;
  const found = await getHomeContext(homeId);
  const [t, tMembers, tHomes] = await Promise.all([
    getTranslations("Manage"),
    getTranslations("Members"),
    getTranslations("Homes"),
  ]);
  if (found.status !== "ok") return { title: await pageTitle(tHomes("homeFallbackTitle")) };
  const directory = await getHomeDirectory(found.context.home.id);
  const member =
    directory.status === "ok"
      ? directory.members.find((entry) => entry.membershipId === membershipId)
      : undefined;
  return {
    title: await pageTitle(
      member
        ? t("memberPageTitle", {
            name: member.name ?? tMembers("noName"),
            home: found.context.home.name,
          })
        : t("memberFallbackTitle"),
    ),
  };
}

/**
 * One member of a Home, with what the viewer may do to them (S12): the Owner changes their role
 * (Member or Administrator), edits an Administrator's rights, asks them to become Owner and removes
 * them; an Administrator granted removeMembers removes Members. The page shows only what the engine
 * allows; every action is decided again by the API and the database. Yourself: your own profile
 * page instead. Someone who is not in this Home: not found.
 */
export default async function MemberPage({ params }: MemberPageProps) {
  const { userId } = await requireIdentity();
  const { homeId, membershipId } = await params;
  const [context, t, tMembers, tHomes] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Manage"),
    getTranslations("Members"),
    getTranslations("Homes"),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, membership } = context;
  const [
    directory,
    formats,
    transfer,
    medicalAccess,
    tPets,
    calendarAccess,
    tCalendar,
    exportAccess,
    tPrivacy,
  ] = await Promise.all([
    getHomeDirectory(home.id),
    getDateTimeFormats(),
    getOwnershipTransfer(home.id),
    readMedicalAccess(home.id),
    getTranslations("Pets"),
    readCalendarAccess(home.id),
    getTranslations("Calendar"),
    getHomeExportAccess(home.id),
    getTranslations("Privacy"),
  ]);
  if (directory.status === "not-found") redirect(HOME_UNAVAILABLE_PATH);
  if (directory.status === "unavailable") {
    return (
      <ErrorState
        title={tMembers("directoryFailedTitle")}
        description={tMembers("directoryFailed")}
      />
    );
  }
  const member = directory.members.find((entry) => entry.membershipId === membershipId);
  if (!member) notFound();
  if (member.isSelf) redirect(`/homes/${home.id}/profile`);

  const can = memberPermissions(membership, {
    homeId: home.id,
    role: member.role,
    isSelf: member.isSelf,
  });
  const grants = can["member.editCapabilities"] ? await getCapabilityGrants(home.id) : null;
  const granted =
    grants?.status === "ok" ? [...(grants.byMembership.get(member.membershipId) ?? [])] : [];
  const name = member.name ?? tMembers("noName");
  const pendingTransfer =
    transfer.status === "ok" && transfer.transfer?.state === "pending" ? transfer.transfer : null;
  const roleKey = {
    owner: "roleOwner",
    administrator: "roleAdministrator",
    member: "roleMember",
  } as const;
  // Pet medical information (S31): shown only to whoever may grant it in this Home.
  const medical =
    medicalAccess.status === "ok" && medicalAccess.value.canGrant
      ? (medicalAccess.value.members.find((entry) => entry.membershipId === member.membershipId) ??
        null)
      : null;
  // The Home calendar level (S32): shown only to calendar managers.
  const calendar =
    calendarAccess.status === "ok" && calendarAccess.value.canManage
      ? (calendarAccess.value.members.find((entry) => entry.membershipId === member.membershipId) ??
        null)
      : null;
  // Home data export (S39): shown only to the Owner, who alone grants it.
  const exporting =
    exportAccess.status === "ok" && exportAccess.value.canGrant
      ? (exportAccess.value.members.find((entry) => entry.membershipId === member.membershipId) ??
        null)
      : null;
  const nothingToDo =
    !Object.values(can).some(Boolean) &&
    !medical?.canChange &&
    !calendar?.canChange &&
    !exporting?.canChange;

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={isolatedName(name)} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`/homes/${home.id}/members`} className="font-medium text-accent-fg underline">
          {t("backToMembers")}
        </Link>
      </p>

      <div className="flex max-w-2xl flex-col gap-6">
        <Card>
          <div className="flex items-center gap-3">
            <MemberAvatar
              name={member.name}
              accentColor={member.accentColor}
              locale={formats.locale}
              avatarFileId={member.avatarFileId ?? null}
            />
            <div className="flex flex-col">
              <span className="text-body font-semibold text-fg" data-testid="member-name">
                <bdi>{name}</bdi>
              </span>
              <span className="text-helper text-fg-muted" data-testid="member-role">
                {tHomes(roleKey[member.role])}
                {" \u{00B7} "}
                {t("joinedOn", { date: formatDateTime(member.joinedAt, formats) })}
              </span>
            </div>
          </div>
          {nothingToDo ? <p className="mt-4 text-body text-fg-muted">{t("noActions")}</p> : null}
        </Card>

        {can["member.changeRole"] && member.role !== "owner" ? (
          <Card title={t("roleSection")} description={t("roleSectionHint")}>
            <MemberRoleForm
              homeId={home.id}
              homeName={home.name}
              membershipId={member.membershipId}
              memberName={name}
              currentRole={member.role}
            />
          </Card>
        ) : null}

        {can["member.editCapabilities"] ? (
          <Card
            title={t("capabilitiesSection")}
            description={t("capabilitiesSectionHint", { name })}
          >
            {grants?.status === "ok" ? (
              <CapabilitiesForm
                homeId={home.id}
                membershipId={member.membershipId}
                memberName={name}
                granted={granted}
              />
            ) : (
              <FormAlert tone="error">{tHomes("loadFailed")}</FormAlert>
            )}
          </Card>
        ) : null}

        {medical ? (
          <Card title={tPets("accessSection")} description={tPets("accessSectionHint", { name })}>
            {medical.canChange ? (
              <MedicalAccessForm
                homeId={home.id}
                membershipId={member.membershipId}
                memberName={name}
                level={medical.level}
              />
            ) : (
              <p className="text-body text-fg-muted" data-testid="pet-access-fixed">
                {medical.role === "owner" ? tPets("accessOwner") : tPets("accessFixed")}
              </p>
            )}
          </Card>
        ) : null}

        {calendar ? (
          <Card
            title={tCalendar("accessSection")}
            description={tCalendar("accessSectionHint", { name })}
          >
            {calendar.canChange && calendar.level !== "manage" ? (
              <CalendarAccessForm
                homeId={home.id}
                membershipId={member.membershipId}
                memberName={name}
                level={calendar.level}
              />
            ) : (
              <p className="text-body text-fg-muted" data-testid="calendar-access-fixed">
                {tCalendar("accessFixed")}
              </p>
            )}
          </Card>
        ) : null}

        {exporting ? (
          <Card
            title={tPrivacy("homeAccessSection")}
            description={tPrivacy("homeAccessSectionHint", { name })}
          >
            {exporting.canChange ? (
              <HomeExportAccessForm
                homeId={home.id}
                membershipId={member.membershipId}
                memberName={name}
                granted={exporting.granted}
              />
            ) : (
              <p className="text-body text-fg-muted" data-testid="home-export-access-fixed">
                {tPrivacy("homeAccessOwner")}
              </p>
            )}
          </Card>
        ) : null}

        {can["member.nominateOwner"] ? (
          <Card title={t("transferSection")} description={t("transferSectionHint", { name })}>
            {pendingTransfer ? (
              <p className="text-body text-fg-muted">{t("transferPendingElsewhere")}</p>
            ) : member.isInactive ? (
              <p className="text-body text-fg-muted" data-testid="transfer-inactive">
                {t("transferInactive", { name })}
              </p>
            ) : (
              <NominateOwner
                homeId={home.id}
                homeName={home.name}
                membershipId={member.membershipId}
                memberName={name}
              />
            )}
          </Card>
        ) : null}

        {can["member.remove"] ? (
          <Card
            title={t("removeSection")}
            description={t("removeSectionHint", { name, home: home.name })}
          >
            <RemoveMember
              homeId={home.id}
              homeName={home.name}
              membershipId={member.membershipId}
              memberName={name}
              currentRole={member.role}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
