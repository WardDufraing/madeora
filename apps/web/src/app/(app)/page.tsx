import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Nav");
  return { title: await pageTitle(t("dashboard")) };
}

// The personal dashboard arrives with S07 (starter dashboard) and S17 (widgets).
export default function DashboardPage() {
  const t = useTranslations("Dashboard");
  const tNav = useTranslations("Nav");
  return (
    <>
      <PageHeader title={tNav("dashboard")} />
      <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
    </>
  );
}
