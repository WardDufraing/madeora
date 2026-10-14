import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { HomePlaceholder } from "@/components/dashboard/home-placeholder";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Homes");
  return { title: await pageTitle(t("createTitle")) };
}

export default async function CreateHomePage() {
  await requireIdentity();
  const t = await getTranslations("Homes");
  return <HomePlaceholder title={t("createTitle")} description={t("createDescription")} />;
}
