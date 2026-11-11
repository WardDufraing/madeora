import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { listMyDeactivationBlockers } from "@/activity/server";
import { parseAccountChangeAction } from "@/auth/google-reauth";
import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { getAccountSecurity } from "@/auth/security-server";
import { verifiedTotpFactor } from "@/auth/two-factor";
import { FormAlert } from "@/components/auth/form-alert";
import { DeleteAccount } from "@/components/deletion/delete-account";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Deletion");
  return { title: await pageTitle(t("accountTitle")) };
}

interface DeleteAccountPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Settings › Privacy › Delete account (S40). Explains what is deleted, what stays and the 30-day
 * recovery period, offers an export first, lists any Home that first needs another Owner, then asks
 * for the confirmation word and a fresh "confirm it's you".
 */
export default async function DeleteAccountPage({ searchParams }: DeleteAccountPageProps) {
  await requireIdentity();
  const [t, params, user, security, blockers] = await Promise.all([
    getTranslations("Deletion"),
    searchParams,
    getVerifiedUser(),
    getAccountSecurity(),
    listMyDeactivationBlockers(),
  ]);
  if (!user) return null;
  const hasPassword = security.status === "ok" ? security.value.hasPassword : true;

  return (
    <>
      <PageHeader title={t("accountTitle")} />
      <p className="mb-4">
        <Link href="/settings/privacy" className="text-body font-medium text-accent-fg underline">
          {t("backToPrivacy")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        <Card title={t("accountWhatTitle")}>
          <ul className="flex list-disc flex-col gap-2 ps-5 text-body">
            <li>{t("accountWhatRecovery")}</li>
            <li>{t("accountWhatSuspended")}</li>
            <li>{t("accountWhatDeleted")}</li>
            <li>{t("accountWhatHomes")}</li>
            <li>{t("accountWhatHistory")}</li>
            <li>{t("accountWhatPrivate")}</li>
            <li>{t("accountWhatGoogle")}</li>
          </ul>
        </Card>
        <Card title={t("accountExportTitle")}>
          <p className="text-body">
            {t("accountExportText")}{" "}
            <Link href="/settings/privacy/export" className="font-medium text-accent-fg underline">
              {t("accountExportLink")}
            </Link>
          </p>
        </Card>
        <Card title={t("accountConfirmTitle")}>
          {blockers.status === "ok" ? (
            <DeleteAccount
              email={user.email ?? ""}
              userId={user.id}
              twoFactor={verifiedTotpFactor(user) !== null}
              hasPassword={hasPassword}
              confirmed={parseAccountChangeAction(params.confirmed)}
              blockers={blockers.value}
            />
          ) : (
            <FormAlert tone="error">{t("unavailable")}</FormAlert>
          )}
        </Card>
      </div>
    </>
  );
}
