import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { LanguageSetting } from "@/components/settings/language-setting";
import { ThemeSetting } from "@/components/settings/theme-setting";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { getDevicePreferences } from "@/preferences/server";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Nav");
  return { title: await pageTitle(t("settings")) };
}

export default async function SettingsPage() {
  await requireIdentity();
  const [tNav, t, locale, { theme }] = await Promise.all([
    getTranslations("Nav"),
    getTranslations("Settings"),
    getLocale(),
    getDevicePreferences(),
  ]);

  return (
    <>
      <PageHeader title={tNav("settings")} />
      <Card title={t("appearance")} className="max-w-xl">
        <div className="flex flex-col gap-6">
          <ThemeSetting initialTheme={theme} />
          <LanguageSetting currentLocale={locale} />
        </div>
      </Card>
    </>
  );
}
