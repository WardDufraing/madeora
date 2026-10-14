import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { InvitationList, type InvitationRow } from "@/components/invitations/invitation-list";
import { InviteForm } from "@/components/invitations/invite-form";
import { JoinRequestList } from "@/components/invitations/join-request-list";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { canSendEmail } from "@/email/send";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { joinUrl } from "@/invitations/links";
import { ACTIVE_INVITATION_LIMIT, emailLanguages, formatJoinCode } from "@/invitations/schema";
import {
  getDateTimeFormats,
  listHomeInvitations,
  listHomeJoinRequests,
} from "@/invitations/server";
import { isOneOf, type InvitationView } from "@/invitations/types";

interface InvitationsPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata({ params }: InvitationsPageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const t = await getTranslations("Invitations");
  const tHomes = await getTranslations("Homes");
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("pageTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

function toRow(invitation: InvitationView): InvitationRow {
  const token = invitation.state === "active" ? invitation.token : null;
  return {
    ...invitation,
    url: token && invitation.kind !== "email" ? joinUrl(token) : null,
    code: token && invitation.kind === "join_code" ? formatJoinCode(token) : null,
  };
}

/**
 * "Invite people" (S10): join requests waiting for a decision, the form for a new email
 * invitation, link or join code, and the Home's invitations. Managers only (the Owner; from S12
 * Administrators granted the capability); everyone else gets a neutral notice. Every action is
 * checked again by the API and the database.
 */
export default async function HomeInvitationsPage({ params }: InvitationsPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, tHomes] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Invitations"),
    getTranslations("Homes"),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, permissions } = context;

  const header = (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={t("title")} />
      <p className="mb-6 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi> {"\u{00B7}"}{" "}
        <Link href={`/homes/${home.id}`} className="font-medium text-accent-fg underline">
          {tHomes("backToHome")}
        </Link>
      </p>
    </>
  );

  if (!permissions["home.invitations.manage"]) {
    return (
      <>
        {header}
        <EmptyState title={t("notManagerTitle")} description={t("notManager")} />
      </>
    );
  }

  const [invitations, requests, formats, locale] = await Promise.all([
    listHomeInvitations(home.id),
    listHomeJoinRequests(home.id),
    getDateTimeFormats(),
    getLocale(),
  ]);
  if (invitations.status !== "ok" || requests.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  const activeCount = invitations.items.filter((item) => item.state === "active").length;

  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-6">
        <Card title={t("requestsTitle")} description={t("requestsDescription")}>
          <JoinRequestList homeId={home.id} requests={requests.items} formats={formats} />
        </Card>
        <Card title={t("createTitle")} description={t("createDescription")}>
          <InviteForm
            homeId={home.id}
            canInviteAdministrators={permissions["home.invitations.manageAdministrators"]}
            emailEnabled={canSendEmail()}
            defaultLanguage={isOneOf(emailLanguages, locale) ? locale : "en"}
            activeCount={activeCount}
            formats={formats}
          />
        </Card>
        <Card
          title={t("listTitle")}
          description={t("listDescription", { count: activeCount, limit: ACTIVE_INVITATION_LIMIT })}
        >
          <InvitationList
            homeId={home.id}
            invitations={invitations.items.map(toRow)}
            formats={formats}
          />
        </Card>
      </div>
    </>
  );
}
