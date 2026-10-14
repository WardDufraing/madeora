import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { CreateHomeForm } from "@/components/homes/create-home-form";
import { PageHeader } from "@/components/shell/page-header";
import { pageTitle } from "@/i18n/page-title";
import { getEffectiveTimeZone } from "@/preferences/server";
import { timeZoneChoices } from "@/preferences/timezone";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Homes");
  return { title: await pageTitle(t("createTitle")) };
}

/**
 * Create a Home (S09). Optional and explicit (spec "Confirmed Home-independent adult account
 * onboarding"): nothing happens until the form is sent, and leaving creates nothing.
 */
export default async function CreateHomePage() {
  await requireIdentity();
  const [t, { timeZone }] = await Promise.all([getTranslations("Homes"), getEffectiveTimeZone()]);
  return (
    <>
      <PageHeader title={t("createTitle")} />
      <p className="mb-6 max-w-xl text-body text-fg-muted">{t("createIntro")}</p>
      <CreateHomeForm defaultTimeZone={timeZone} timeZoneChoices={timeZoneChoices([timeZone])} />
    </>
  );
}
