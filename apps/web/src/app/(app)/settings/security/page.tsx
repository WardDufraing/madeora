import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { parseAccountChangeAction } from "@/auth/google-reauth";
import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { getAccountSecurity, getMySessions, getMyTrustedDevices } from "@/auth/security-server";
import { verifiedTotpFactor } from "@/auth/two-factor";
import { FormAlert } from "@/components/auth/form-alert";
import { AccountRecoveryCodesSetting } from "@/components/security/account-recovery-codes-setting";
import { BackupEmailSetting } from "@/components/security/backup-email-setting";
import { EmailSetting } from "@/components/security/email-setting";
import { PasswordSetting } from "@/components/security/password-setting";
import { RecoveryBanner } from "@/components/security/recovery-banner";
import { SessionsSetting } from "@/components/security/sessions-setting";
import { TrustedDevicesSetting } from "@/components/security/trusted-devices-setting";
import { TwoFactorSetting } from "@/components/security/two-factor-setting";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Security");
  return { title: await pageTitle(t("title")) };
}

interface SecurityPageProps {
  readonly searchParams: Promise<{
    readonly twoFactor?: string;
    readonly codes?: string;
    readonly recovered?: string;
    readonly email?: string;
    readonly backup?: string;
    readonly accountCodes?: string;
    readonly recovery?: string;
    /** A change Google has just confirmed (accounts without a password). */
    readonly confirmed?: string;
  }>;
}

const notices = {
  backup: { removed: "backupRemovedNotice", cancelled: "backupCancelledNotice" },
  accountCodes: { new: "accountCodesNewNotice" },
  recovery: { cancelled: "recoveryCancelledNotice" },
} as const;

/**
 * Settings › Security (S37): two-factor sign-in, password, account email, recovery methods
 * (backup email and account recovery codes), trusted browsers, and devices and sessions. Everything here is the signed-in account's own and account-wide (the same in every
 * Home); nobody else, whatever their Home role, can see or change it. Every change needs a fresh
 * reauthentication (password, or Google for accounts without one) except what only takes
 * something away (ending a session or trust, cancelling a pending change or a recovery), which
 * must be possible at once.
 */
export default async function SecurityPage({ searchParams }: SecurityPageProps) {
  await requireIdentity();
  const [t, tActivity, tSettings, tLifecycle, user, security, sessions, trusted, formats, params] =
    await Promise.all([
      getTranslations("Security"),
      getTranslations("Activity"),
      getTranslations("Settings"),
      getTranslations("Lifecycle"),
      getVerifiedUser(),
      getAccountSecurity(),
      getMySessions(),
      getMyTrustedDevices(),
      getDateTimeFormats(),
      searchParams,
    ]);
  if (!user) return null;
  const email = user.email ?? "";
  const factor = verifiedTotpFactor(user);
  const status = security.status === "ok" ? security.value : null;
  const twoFactor = factor !== null;
  const hasPassword = status?.hasPassword ?? false;
  const confirmed = hasPassword ? null : parseAccountChangeAction(params.confirmed);
  const shared = { email, userId: user.id, twoFactor, hasPassword, confirmed };
  const notice =
    (params.backup === "removed" || params.backup === "cancelled"
      ? notices.backup[params.backup]
      : null) ??
    (params.accountCodes === "new" ? notices.accountCodes.new : null) ??
    (params.recovery === "cancelled" ? notices.recovery.cancelled : null);

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4">
        <Link href="/settings" className="text-body font-medium text-accent-fg underline">
          {tSettings("notificationsBack")}
        </Link>
      </p>
      <p className="mb-4 flex flex-wrap gap-4">
        <Link
          href="/settings/security/activity"
          className="text-body font-medium text-accent-fg underline"
          data-testid="security-activity-link"
        >
          {tActivity("securityLink")}
        </Link>
        <Link
          href="/settings/security/notifications"
          className="text-body font-medium text-accent-fg underline"
        >
          {tActivity("alertsLink")}
        </Link>
        <Link
          href="/settings/security/deactivate"
          className="text-body font-medium text-accent-fg underline"
          data-testid="deactivate-link"
        >
          {tLifecycle("deactivateLink")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        {security.status === "unavailable" ||
        sessions.status === "unavailable" ||
        trusted.status === "unavailable" ? (
          <FormAlert tone="error">{tSettings("loadFailed")}</FormAlert>
        ) : null}
        {params.recovered === "1" ? (
          <FormAlert tone="info" announce>
            {t("recoveredNotice")}
          </FormAlert>
        ) : null}
        {params.twoFactor === "on" ? (
          <FormAlert tone="success" announce>
            {t("twoFactorOnNotice")}
          </FormAlert>
        ) : null}
        {params.twoFactor === "off" ? (
          <FormAlert tone="success" announce>
            {t("twoFactorOffNotice")}
          </FormAlert>
        ) : null}
        {params.codes === "new" ? (
          <FormAlert tone="success" announce>
            {t("codesReplacedNotice")}
          </FormAlert>
        ) : null}
        {params.email === "cancelled" ? (
          <FormAlert tone="success" announce>
            {t("emailCancelledNotice")}
          </FormAlert>
        ) : null}

        {notice ? (
          <FormAlert tone="success" announce>
            {t(notice)}
          </FormAlert>
        ) : null}
        {status && (status.recoveryWaitingUntil !== null || status.recoveryReady) ? (
          <RecoveryBanner
            waitingUntil={
              status.recoveryWaitingUntil
                ? formatDateTime(status.recoveryWaitingUntil, formats)
                : null
            }
            ready={status.recoveryReady}
          />
        ) : null}

        <div id="two-factor" className="scroll-mt-20">
          <Card title={t("twoFactorTitle")} description={t("twoFactorHint")}>
            <TwoFactorSetting
              {...shared}
              enabled={twoFactor}
              factorId={factor?.id ?? null}
              recoveryCodesLeft={status?.recoveryCodesLeft ?? 0}
            />
          </Card>
        </div>
        <div id="password" className="scroll-mt-20">
          <Card title={t("passwordTitle")} description={t("passwordHint")}>
            <PasswordSetting {...shared} />
          </Card>
        </div>
        <div id="email" className="scroll-mt-20">
          <Card title={t("emailTitle")} description={t("emailHint")}>
            <EmailSetting {...shared} pendingEmail={user.new_email ?? null} />
          </Card>
        </div>
        <div id="recovery" className="scroll-mt-20">
          <Card title={t("recoveryMethodsTitle")} description={t("recoveryMethodsHint")}>
            {status ? (
              <div className="flex flex-col gap-6">
                <section aria-labelledby="backup-email-heading" className="flex flex-col gap-3">
                  <h3 id="backup-email-heading" className="text-body font-semibold">
                    {t("backupEmailTitle")}
                  </h3>
                  <BackupEmailSetting
                    {...shared}
                    backupEmail={status.backupEmail}
                    pendingBackupEmail={status.backupEmailPending}
                  />
                </section>
                <section aria-labelledby="account-codes-heading" className="flex flex-col gap-3">
                  <h3 id="account-codes-heading" className="text-body font-semibold">
                    {t("accountCodesTitle")}
                  </h3>
                  <AccountRecoveryCodesSetting
                    {...shared}
                    codesLeft={status.accountRecoveryCodesLeft}
                    hasBackupEmail={status.backupEmail !== null}
                  />
                </section>
              </div>
            ) : null}
          </Card>
        </div>
        {twoFactor ? (
          <div id="trusted" className="scroll-mt-20">
            <Card title={t("trustedTitle")} description={t("trustedHint")}>
              {trusted.status === "ok" ? (
                <TrustedDevicesSetting
                  devices={trusted.value.map((device) => ({
                    id: device.id,
                    device: device.device,
                    trusted: formatDateTime(device.createdAt, formats),
                    expires: formatDateTime(device.expiresAt, formats),
                    isCurrent: device.isCurrent,
                  }))}
                />
              ) : null}
            </Card>
          </div>
        ) : null}
        <div id="sessions" className="scroll-mt-20">
          <Card title={t("sessionsTitle")} description={t("sessionsHint")}>
            {sessions.status === "ok" ? (
              <SessionsSetting
                sessions={sessions.value.map((session) => ({
                  id: session.id,
                  device: session.device,
                  created: formatDateTime(session.createdAt, formats),
                  lastActive: formatDateTime(session.lastActiveAt, formats),
                  isCurrent: session.isCurrent,
                }))}
              />
            ) : null}
          </Card>
        </div>
      </div>
    </>
  );
}
