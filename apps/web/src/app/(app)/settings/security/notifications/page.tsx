import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { getSecurityAlertPreferences, listMySecurityNotices } from "@/activity/server";
import { requireIdentity } from "@/auth/identity";
import { SecurityAlertsSetting } from "@/components/activity/security-alerts-setting";
import { FormAlert } from "@/components/auth/form-alert";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Activity");
  return { title: await pageTitle(t("alertsTitle")) };
}

const noticeKey = {
  "account.new_device_sign_in": "new_device_sign_in",
  "account.unfinished_sign_in": "unfinished_sign_in",
  "account.signed_in": "signed_in",
  "account.security_report_ready": "security_report_ready",
} as const;

function noticeOf(kind: string): (typeof noticeKey)[keyof typeof noticeKey] | "other" {
  return kind in noticeKey ? noticeKey[kind as keyof typeof noticeKey] : "other";
}

/**
 * Settings › Security › Security notifications (S38, spec "Confirmed risk-based account security
 * notifications"): which alerts are always sent, the optional sign-in alerts, and recent security
 * notices with their delivery state. Account-wide, the same in every Home.
 */
export default async function SecurityNotificationsPage() {
  await requireIdentity();
  const [t, formats, preferences, notices] = await Promise.all([
    getTranslations("Activity"),
    getDateTimeFormats(),
    getSecurityAlertPreferences(),
    listMySecurityNotices(),
  ]);

  return (
    <>
      <PageHeader title={t("alertsTitle")} />
      <p className="mb-2 max-w-2xl text-body text-fg-muted">{t("alertsHint")}</p>
      <p className="mb-4">
        <Link href="/settings/security" className="text-body font-medium text-accent-fg underline">
          {t("alertsBack")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        <Card title={t("mandatoryTitle")}>
          <p className="text-body">{t("mandatoryHint")}</p>
        </Card>
        <Card>
          {preferences.status === "ok" ? (
            <SecurityAlertsSetting
              newDevice={preferences.value.newDevice}
              everySignIn={preferences.value.everySignIn}
            />
          ) : (
            <FormAlert tone="error">{t("unavailableHint")}</FormAlert>
          )}
        </Card>
        <Card title={t("recentTitle")}>
          {notices.status === "unavailable" ? (
            <FormAlert tone="error">{t("recentUnavailable")}</FormAlert>
          ) : notices.value.length === 0 ? (
            <p className="text-helper text-fg-muted">{t("recentEmpty")}</p>
          ) : (
            <>
              <ul className="flex flex-col divide-y divide-line" data-testid="security-notices">
                {notices.value.map((notice) => (
                  <li key={notice.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span className="text-body">{t(`notice.${noticeOf(notice.kind)}`)}</span>
                    <span className="text-helper text-fg-muted">
                      {formatDateTime(notice.createdAt, formats)} ·{" "}
                      {t(`emailState.${notice.emailStatus}`)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-helper text-fg-muted">{t("deliveryNote")}</p>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
