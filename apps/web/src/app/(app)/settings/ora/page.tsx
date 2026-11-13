import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { OraSettingsForm } from "@/components/ora/ora-settings-form";
import { PageHeader } from "@/components/shell/page-header";
import { pageTitle } from "@/i18n/page-title";
import { listMyHomes } from "@/homes/server";
import { getOraSettings } from "@/ora/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("OraSettings");
  return { title: await pageTitle(t("pageTitle")) };
}

/**
 * Ora settings (S45): show or hide and disable Ora, the personal motion mode, and the colour in
 * Personal space and in each Home. All personal: nobody, an Owner included, sees or sets another
 * member's. Reachable even while Ora is hidden, so it can be switched back on.
 */
export default async function OraSettingsPage() {
  await requireIdentity();
  const [t, settings, myHomes] = await Promise.all([
    getTranslations("OraSettings"),
    getOraSettings(),
    listMyHomes(),
  ]);
  const homes = myHomes.status === "ok" ? myHomes.homes.map(({ id, name }) => ({ id, name })) : [];
  return (
    <>
      <PageHeader title={t("pageTitle")} />
      <div className="max-w-2xl">
        <OraSettingsForm settings={settings} homes={homes} />
      </div>
    </>
  );
}
