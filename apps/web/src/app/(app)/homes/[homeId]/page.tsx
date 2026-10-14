import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { isolatedName, loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { RoleLabel } from "@/components/homes/role-label";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { countPendingJoinRequests } from "@/invitations/server";

// Typed here rather than with Next's generated PageProps, which only exist after `next typegen`.
interface HomePageProps {
  readonly params: Promise<{ readonly homeId: string }>;
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
 * "Invite people" link with the number of join requests waiting (S10).
 */
export default async function HomeDashboardPage({ params }: HomePageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const { home, membership, permissions } = context;
  const canInvite = permissions["home.invitations.manage"];
  const [pendingRequests, tInvitations] = await Promise.all([
    canInvite ? countPendingJoinRequests(home.id) : Promise.resolve(0),
    getTranslations("Invitations"),
  ]);

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={isolatedName(home.name)} />
      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2">
        <p className="text-body text-fg-muted" data-testid="home-role">
          <RoleLabel role={membership.role} />
        </p>
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
