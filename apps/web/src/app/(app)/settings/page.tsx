import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";

import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { isGoogleSignInEnabled } from "@/auth/providers";
import { describeSignInMethods } from "@/auth/sign-in-methods";
import { FormAlert } from "@/components/auth/form-alert";
import { AccentSetting } from "@/components/settings/accent-setting";
import { DisplayNameSetting } from "@/components/settings/display-name-setting";
import { LanguageSetting } from "@/components/settings/language-setting";
import { RegionalSetting } from "@/components/settings/regional-setting";
import { SignInMethodsSetting } from "@/components/settings/sign-in-methods-setting";
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

interface SettingsPageProps {
  readonly searchParams: Promise<{ readonly linked?: string; readonly unlinked?: string }>;
}

/**
 * Account preferences (the same on every device, S07), sign-in methods (S08) and this device's
 * appearance (S05). Each form saves on its own, so a failed save never loses what was typed in
 * another.
 */
export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const { userId } = await requireIdentity();
  const [
    tNav,
    t,
    locale,
    account,
    { theme },
    deviceTimeZone,
    regional,
    user,
    googleEnabled,
    params,
  ] = await Promise.all([
    getTranslations("Nav"),
    getTranslations("Settings"),
    getLocale(),
    getAccountPreferences(),
    getDevicePreferences(),
    getDeviceTimeZone(),
    getRegionalFormats(),
    getVerifiedUser(),
    isGoogleSignInEnabled(),
    searchParams,
  ]);
  const stored = account.status === "ok" ? account.preferences : noPreferences;

  return (
    <>
      <PageHeader title={tNav("settings")} />
      <div className="flex max-w-2xl flex-col gap-6">
        {account.status === "unavailable" ? (
          <FormAlert tone="error">{t("loadFailed")}</FormAlert>
        ) : null}
        <Card title={t("profile")} description={t("profileHint")}>
          <DisplayNameSetting initialName={stored.displayName} />
        </Card>
        <Card title={t("accent")} description={t("accentHint")}>
          <AccentSetting initialColor={stored.accentColor} />
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
        {user ? (
          <div id="sign-in-methods" className="scroll-mt-20">
            <Card title={t("signInMethods")} description={t("signInMethodsHint")}>
              <SignInMethodsSetting
                userId={userId}
                methods={describeSignInMethods(user)}
                googleAvailable={googleEnabled}
                notice={
                  params.linked === "google"
                    ? "linked"
                    : params.unlinked === "google"
                      ? "unlinked"
                      : null
                }
              />
            </Card>
          </div>
        ) : null}
        <Card title={t("appearance")}>
          <ThemeSetting initialTheme={theme} />
        </Card>
      </div>
    </>
  );
}
