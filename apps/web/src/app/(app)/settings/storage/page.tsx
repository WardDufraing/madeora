import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { PageHeader } from "@/components/shell/page-header";
import { StorageUsageView } from "@/components/storage/storage-usage";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";
import { getMyStorageUsage } from "@/storage/usage";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Storage");
  return { title: await pageTitle(t("pageTitle")) };
}

/**
 * The signed-in person's personal storage (S15): used, recently deleted, available and total, with
 * the 80% and 95% warnings. Read with their own session; nobody else's pool is ever shown here.
 */
export default async function PersonalStoragePage() {
  await requireIdentity();
  const [t, locale, result] = await Promise.all([
    getTranslations("Storage"),
    getLocale(),
    getMyStorageUsage(),
  ]);

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4">
        <Link href="/settings" className="text-body font-medium text-accent-fg underline">
          {t("backToSettings")}
        </Link>
      </p>
      <p className="mb-6 max-w-2xl text-body text-fg-muted">{t("personalIntro")}</p>
      {result.status === "ok" ? (
        <Card title={t("title")} className="max-w-2xl">
          <StorageUsageView usage={result.usage} locale={locale} pool="personal" />
        </Card>
      ) : (
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      )}
    </>
  );
}
