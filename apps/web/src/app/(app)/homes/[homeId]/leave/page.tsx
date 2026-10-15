import { memberPermissions } from "@madeora/domain/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { requireIdentity } from "@/auth/identity";
import { HOME_UNAVAILABLE_PATH, loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { MemberAvatar } from "@/components/members/member-avatar";
import { LeaveHome } from "@/components/members/manage/leave-home";
import { NominateOwner } from "@/components/members/manage/nominate-owner";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats } from "@/invitations/server";
import { getHomeDirectory } from "@/members/directory";
import { getOwnershipTransfer } from "@/members/manage-server";

interface LeavePageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata({ params }: LeavePageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Manage"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("leavePageTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

/**
 * Leaving a Home (S12; spec "Confirmed voluntary Home departure", "Confirmed guided
 * transfer-or-close for departing Home Owner"). Members and Administrators see the consequences and
 * leave after one confirmation. The Owner gets the guided transfer-or-close page instead: choose a
 * member to hand ownership to (they must accept), or close the Home, which arrives with Home
 * deletion (S40). The Owner can never leave from here.
 */
export default async function LeavePage({ params }: LeavePageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, tMembers, tHomes] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Manage"),
    getTranslations("Members"),
    getTranslations("Homes"),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, membership, permissions } = context;
  const header = (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={t("leaveTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`/homes/${home.id}`} className="font-medium text-accent-fg underline">
          {tHomes("backToHome")}
        </Link>
      </p>
    </>
  );

  if (permissions["home.leave"]) {
    return (
      <>
        {header}
        <Card className="max-w-2xl">
          <p className="mb-4 text-body text-fg">{t("leaveIntro", { home: home.name })}</p>
          <p className="mb-2 text-body font-medium text-fg">{t("leaveConsequences")}</p>
          <ul className="mb-6 flex list-disc flex-col gap-1 ps-5 text-body text-fg">
            <li>{t("leaveAccess")}</li>
            <li>{t("leaveProfile")}</li>
            <li>{t("leaveContent")}</li>
            <li>{t("leaveRejoin")}</li>
          </ul>
          <LeaveHome homeId={home.id} homeName={home.name} />
        </Card>
      </>
    );
  }

  // The Owner: transfer or close.
  if (!permissions["home.ownership.transfer"]) redirect(HOME_UNAVAILABLE_PATH);
  const [directory, transfer, formats] = await Promise.all([
    getHomeDirectory(home.id),
    getOwnershipTransfer(home.id),
    getDateTimeFormats(),
  ]);
  if (directory.status === "not-found") redirect(HOME_UNAVAILABLE_PATH);
  const pending =
    transfer.status === "ok" && transfer.transfer?.state === "pending" ? transfer.transfer : null;
  const candidates =
    directory.status === "ok"
      ? directory.members.filter(
          (member) =>
            memberPermissions(membership, {
              homeId: home.id,
              role: member.role,
              isSelf: member.isSelf,
            })["member.nominateOwner"],
        )
      : [];
  const pendingName = pending
    ? ((directory.status === "ok"
        ? directory.members.find((m) => m.membershipId === pending.recipientMembershipId)?.name
        : null) ?? tMembers("noName"))
    : null;

  return (
    <>
      {header}
      <div className="flex max-w-2xl flex-col gap-6">
        <p className="text-body text-fg">{t("ownerLeaveIntro", { home: home.name })}</p>
        <Card title={t("ownerTransferTitle")} description={t("ownerTransferHint")}>
          {directory.status === "unavailable" ? (
            <ErrorState
              title={tMembers("directoryFailedTitle")}
              description={tMembers("directoryFailed")}
            />
          ) : pending ? (
            <p className="text-body text-fg" data-testid="owner-pending-transfer">
              {t("ownerPending", { name: pendingName ?? "" })}{" "}
              <Link href={`/homes/${home.id}`} className="font-medium text-accent-fg underline">
                {tHomes("backToHome")}
              </Link>
            </p>
          ) : candidates.length === 0 ? (
            <p className="text-body text-fg-muted">{t("ownerNoCandidates")}</p>
          ) : (
            <ul className="divide-y divide-line" aria-label={t("ownerTransferTitle")}>
              {candidates.map((member) => (
                <li
                  key={member.membershipId}
                  className="flex flex-wrap items-center gap-3 py-3"
                  data-testid="transfer-candidate"
                >
                  <MemberAvatar
                    name={member.name}
                    accentColor={member.accentColor}
                    locale={formats.locale}
                    avatarFileId={member.avatarFileId ?? null}
                  />
                  <span className="min-w-0 flex-1 text-body text-fg">
                    {member.name === null ? tMembers("noName") : <bdi>{member.name}</bdi>}
                  </span>
                  <NominateOwner
                    homeId={home.id}
                    homeName={home.name}
                    membershipId={member.membershipId}
                    memberName={member.name ?? tMembers("noName")}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t("ownerCloseTitle")}>
          <p className="text-body text-fg-muted">{t("ownerCloseText")}</p>
        </Card>
      </div>
    </>
  );
}
