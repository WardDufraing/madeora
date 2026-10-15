import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { NotificationSettings } from "@/components/notifications/notification-settings";
import { PageHeader } from "@/components/shell/page-header";
import { listMyHomes } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getNotificationSettings } from "@/notifications/server";
import { getDeviceTimeZone, getEffectiveTimeZone } from "@/preferences/server";
import { timeZoneChoices } from "@/preferences/timezone";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("NotificationSettings");
  return { title: await pageTitle(t("title")) };
}

/**
 * Notification settings (S14): global defaults, per-Home overrides and quiet hours. Only the
 * signed-in person's own choices are read, and only they can change them.
 */
export default async function NotificationSettingsPage() {
  await requireIdentity();
  const [t, tSettings, settings, homes, zone, deviceZone] = await Promise.all([
    getTranslations("NotificationSettings"),
    getTranslations("Settings"),
    getNotificationSettings(),
    listMyHomes(),
    getEffectiveTimeZone(),
    getDeviceTimeZone(),
  ]);
  const myHomes = homes.status === "ok" ? homes.homes : [];

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4">
        <Link href="/settings" className="text-body font-medium text-accent-fg underline">
          {tSettings("notificationsBack")}
        </Link>
      </p>
      {settings.status === "unavailable" ? (
        <FormAlert tone="error">{tSettings("loadFailed")}</FormAlert>
      ) : (
        <NotificationSettings
          account={{ id: null, name: t("accountTitle"), suggestedTimeZone: zone.timeZone }}
          homes={myHomes.map((home) => ({
            id: home.id,
            name: home.name,
            suggestedTimeZone: home.timeZone,
          }))}
          zoneChoices={timeZoneChoices([
            zone.timeZone,
            deviceZone,
            ...myHomes.map((home) => home.timeZone),
          ])}
          emailVerified={settings.value.emailVerified}
          preferences={settings.value.preferences}
          quietHours={settings.value.quietHours}
        />
      )}
    </>
  );
}
