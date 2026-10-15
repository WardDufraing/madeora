import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { PageHeader } from "@/components/shell/page-header";
import { StorageUsageView } from "@/components/storage/storage-usage";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getHomeStorageUsage } from "@/storage/usage";

interface HomeStoragePageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata({ params }: HomeStoragePageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Storage"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("homePageTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

/**
 * A Home's storage (S15), for its storage managers: the Owner and Administrators granted the
 * manageHomeSettings right. Everyone else sees why it is hidden. The database refuses the read for
 * anyone else too; the permission check here only decides what to render.
 */
export default async function HomeStoragePage({ params }: HomeStoragePageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, tHomes, locale] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Storage"),
    getTranslations("Homes"),
    getLocale(),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, permissions } = context;
  const result = permissions["home.storage.view"] ? await getHomeStorageUsage(home.id) : null;

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={t("title")} />
      <p className="mb-4 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`/homes/${home.id}/settings`} className="font-medium text-accent-fg underline">
          {tHomes("settingsTitle")}
        </Link>
      </p>
      {result === null || result.status === "not-found" ? (
        <EmptyState title={t("notManagerTitle")} description={t("notManager")} />
      ) : result.status === "unavailable" ? (
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      ) : (
        <>
          <p className="mb-6 max-w-2xl text-body text-fg-muted">{t("homeIntro")}</p>
          <Card title={t("title")} className="max-w-2xl">
            <StorageUsageView usage={result.usage} locale={locale} pool="home" />
          </Card>
        </>
      )}
    </>
  );
}
