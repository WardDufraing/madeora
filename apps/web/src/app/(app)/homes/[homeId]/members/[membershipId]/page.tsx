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
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getHomeDirectory } from "@/members/directory";
import { getCapabilityGrants, getOwnershipTransfer } from "@/members/manage-server";

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
  const [directory, formats, transfer] = await Promise.all([
    getHomeDirectory(home.id),
    getDateTimeFormats(),
    getOwnershipTransfer(home.id),
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
  const nothingToDo = !Object.values(can).some(Boolean);

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

        {can["member.nominateOwner"] ? (
          <Card title={t("transferSection")} description={t("transferSectionHint", { name })}>
            {pendingTransfer ? (
              <p className="text-body text-fg-muted">{t("transferPendingElsewhere")}</p>
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
