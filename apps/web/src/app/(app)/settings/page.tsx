import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { DisplayNameSetting } from "@/components/settings/display-name-setting";
import { LanguageSetting } from "@/components/settings/language-setting";
import { RegionalSetting } from "@/components/settings/regional-setting";
import { ThemeSetting } from "@/components/settings/theme-setting";
import { TimeZoneSetting } from "@/components/settings/time-zone-setting";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";
import { getAccountPreferences } from "@/preferences/account";
import { regionalSamples } from "@/preferences/regional";
import { noPreferences } from "@/preferences/schema";
import { getDevicePreferences, getDeviceTimeZone, getRegionalFormats } from "@/preferences/server";
import { timeZoneChoices } from "@/preferences/timezone";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Nav");
  return { title: await pageTitle(t("settings")) };
}

/**
 * Account preferences (the same on every device, S07) and this device's appearance (S05).
 * Each form saves on its own, so a failed save never loses what was typed in another.
 */
export default async function SettingsPage() {
  await requireIdentity();
  const [tNav, t, locale, account, { theme }, deviceTimeZone, regional] = await Promise.all([
    getTranslations("Nav"),
    getTranslations("Settings"),
    getLocale(),
    getAccountPreferences(),
    getDevicePreferences(),
    getDeviceTimeZone(),
    getRegionalFormats(),
  ]);
  const stored = account.status === "ok" ? account.preferences : noPreferences;

  return (
    <>
      <PageHeader title={tNav("settings")} />
      <div className="flex max-w-2xl flex-col gap-6">
        {account.status === "unavailable" ? (
          <FormAlert tone="error">{t("loadFailed")}</FormAlert>
        ) : null}
        <Card title={t("profile")}>
          <DisplayNameSetting initialName={stored.displayName} />
        </Card>
        <Card title={t("languageAndRegion")} description={t("languageAndRegionHint")}>
          <div className="flex flex-col gap-8">
            <LanguageSetting currentLocale={locale} />
            <RegionalSetting
              overrides={stored}
              detected={regional.detected}
              samples={regionalSamples(locale)}
            />
            <TimeZoneSetting
              chosen={stored.timeZone}
              deviceSaved={deviceTimeZone}
              choices={timeZoneChoices([stored.timeZone, deviceTimeZone])}
              locale={locale}
              timeFormat={regional.effective.timeFormat}
            />
          </div>
        </Card>
        <Card title={t("appearance")}>
          <ThemeSetting initialTheme={theme} />
        </Card>
      </div>
    </>
  );
}
