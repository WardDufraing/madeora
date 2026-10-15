import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { isolatedName, loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { RoleLabel } from "@/components/homes/role-label";
import { OwnershipTransferNotice } from "@/components/members/manage/ownership-transfer-notice";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { countPendingJoinRequests } from "@/invitations/server";
import { transferAnswers } from "@/members/manage-schema";

// Typed here rather than with Next's generated PageProps, which only exist after `next typegen`.
interface HomePageProps {
  readonly params: Promise<{ readonly homeId: string }>;
  readonly searchParams: Promise<{ readonly transfer?: string | string[] }>;
}

export async function generateMetadata({ params }: HomePageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const t = await getTranslations("Homes");
  // A Home the person cannot open gets a generic title, never its name.
  return {
    title: await pageTitle(
      found.status === "ok" ? found.context.home.name : t("homeFallbackTitle"),
    ),
  };
}

/**
 * A Home's dashboard (S09): the Home context made explicit, with the person's role there. Widgets
 * arrive with S17 and the modules. Nothing personal is shown here. Invitation managers get an
 * "Invite people" link with the number of join requests waiting (S10). Every member gets the
 * member directory and their own "How you appear here" page (S11). A pending ownership transfer
 * shows to the Owner who asked and the member asked, with its answers (S12).
 */
export default async function HomeDashboardPage({ params, searchParams }: HomePageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const { transfer } = await searchParams;
  const [context, t] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const { home, membership, permissions } = context;
  // The banner's answer, confirmed again after the reload; only when it fits the viewer's role now,
  // so a hand-made link cannot claim an ownership change that did not happen.
  const transferDone = transferAnswers.find(
    (answer) => answer === transfer && (answer === "declined") !== (membership.role === "owner"),
  );
  const canInvite = permissions["home.invitations.manage"];
  const [pendingRequests, tInvitations, tMembers] = await Promise.all([
    canInvite ? countPendingJoinRequests(home.id) : Promise.resolve(0),
    getTranslations("Invitations"),
    getTranslations("Members"),
  ]);

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={isolatedName(home.name)} />
      <OwnershipTransferNotice homeId={home.id} homeName={home.name} done={transferDone} />
      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2">
        <p className="text-body text-fg-muted" data-testid="home-role">
          <RoleLabel role={membership.role} />
        </p>
        <Link
          href={`/homes/${home.id}/members`}
          className="text-body font-medium text-accent-fg underline"
          data-testid="members-link"
        >
          {tMembers("directoryLink")}
        </Link>
        <Link
          href={`/homes/${home.id}/profile`}
          className="text-body font-medium text-accent-fg underline"
        >
          {tMembers("profileLink")}
        </Link>
        <Link
          href={`/homes/${home.id}/settings`}
          className="text-body font-medium text-accent-fg underline"
        >
          {t("settingsLink")}
        </Link>
        {canInvite ? (
          <Link
            href={`/homes/${home.id}/invitations`}
            className="text-body font-medium text-accent-fg underline"
            data-testid="invite-people-link"
          >
            {pendingRequests > 0
              ? tInvitations("invitePeopleWithRequests", { count: pendingRequests })
              : tInvitations("invitePeople")}
          </Link>
        ) : null}
      </div>
      <Card title={t("widgetsTitle")}>
        <EmptyState title={t("widgetsEmptyTitle")} description={t("widgetsEmptyDescription")} />
      </Card>
    </>
  );
}
