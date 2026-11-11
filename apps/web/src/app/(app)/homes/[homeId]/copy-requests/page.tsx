import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { HomeCopyRequests } from "@/components/copies/home-copy-requests";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { listHomeCopyRequests } from "@/copies/server";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";

interface HomeCopyRequestsPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata({ params }: HomeCopyRequestsPageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const t = await getTranslations("HomeCopies");
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("requestsPageTitle", { home: found.context.home.name })
        : t("requestsTitle"),
    ),
  };
}

/**
 * A Home's copy requests (S40 part 2): the pending requests to copy a member's personal item into
 * this Home, for the Owner, the Administrators and each request's own creator. The database decides
 * who may approve on every decision.
 */
export default async function HomeCopyRequestsPage({ params }: HomeCopyRequestsPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, formats, requests] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("HomeCopies"),
    getDateTimeFormats(),
    listHomeCopyRequests(homeId),
  ]);
  if (!context || requests.status !== "ok") {
    return <ErrorState title={t("requestsTitle")} description={t("unavailable")} />;
  }
  const { home } = context;

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={t("requestsTitle")} />
      <div className="flex max-w-2xl flex-col gap-6">
        <Card title={t("requestsCardTitle", { home: home.name })}>
          <p className="mb-4 text-body">{t("requestsIntro")}</p>
          <HomeCopyRequests
            homeName={home.name}
            rows={requests.value.requests.map((row) => ({
              id: row.id,
              itemType: row.itemType,
              label: row.label,
              files: row.files,
              requester: row.requester,
              isMine: row.isMine,
              requested: formatDateTime(row.requestedAt, formats),
              expires: formatDateTime(row.expiresAt, formats),
            }))}
          />
        </Card>
      </div>
    </>
  );
}
