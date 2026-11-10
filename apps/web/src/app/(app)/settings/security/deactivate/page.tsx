import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { listMyDeactivationBlockers } from "@/activity/server";
import { parseAccountChangeAction } from "@/auth/google-reauth";
import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { getAccountSecurity } from "@/auth/security-server";
import { verifiedTotpFactor } from "@/auth/two-factor";
import { DeactivateAccount } from "@/components/account/deactivate-account";
import { FormAlert } from "@/components/auth/form-alert";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Lifecycle");
  return { title: await pageTitle(t("deactivateTitle")) };
}

interface DeactivatePageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Settings › Security › Deactivate account (S38). Explains what deactivation suspends and what it
 * is not, lists any Home that first needs another Owner, then asks to confirm.
 */
export default async function DeactivatePage({ searchParams }: DeactivatePageProps) {
  await requireIdentity();
  const [t, params, user, security, blockers] = await Promise.all([
    getTranslations("Lifecycle"),
    searchParams,
    getVerifiedUser(),
    getAccountSecurity(),
    listMyDeactivationBlockers(),
  ]);
  if (!user) return null;
  const hasPassword = security.status === "ok" ? security.value.hasPassword : true;

  return (
    <>
      <PageHeader title={t("deactivateTitle")} />
      <p className="mb-4">
        <Link href="/settings/security" className="text-body font-medium text-accent-fg underline">
          {t("backToSecurity")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        <Card title={t("whatHappensTitle")}>
          <ul className="flex list-disc flex-col gap-2 ps-5 text-body">
            <li>{t("whatSessions")}</li>
            <li>{t("whatNotifications")}</li>
            <li>{t("whatIntegrations")}</li>
            <li>{t("whatHomes")}</li>
            <li>{t("whatKept")}</li>
            <li>{t("whatReturn")}</li>
          </ul>
        </Card>
        <Card title={t("notTitle")}>
          <ul className="flex list-disc flex-col gap-2 ps-5 text-body">
            <li>{t("notSignOut")}</li>
            <li>{t("notLeave")}</li>
            <li>{t("notClose")}</li>
            <li>{t("notDelete")}</li>
          </ul>
        </Card>
        <Card title={t("responsibilitiesTitle")}>
          <p className="mb-4 text-body">{t("responsibilities")}</p>
          {blockers.status === "ok" ? (
            <DeactivateAccount
              email={user.email ?? ""}
              userId={user.id}
              twoFactor={verifiedTotpFactor(user) !== null}
              hasPassword={hasPassword}
              confirmed={parseAccountChangeAction(params.confirmed)}
              blockers={blockers.value}
            />
          ) : (
            <FormAlert tone="error">{t("deactivateUnavailable")}</FormAlert>
          )}
        </Card>
      </div>
    </>
  );
}
