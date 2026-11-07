import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { parseLinkToken } from "@/auth/schemas";
import { ConfirmBackupEmail } from "@/components/security/confirm-backup-email";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../../auth-page-title";

interface ConfirmBackupEmailPageProps {
  readonly searchParams: Promise<{ readonly token?: string | string[] }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Security");
  return { title: await pageTitle(t("confirmBackupTitle")) };
}

/**
 * The link sent to a new backup address opens this page (S37). It counts only for the account
 * that asked for it, so the person signs in first (and comes back here afterwards).
 */
export default async function ConfirmBackupEmailPage({
  searchParams,
}: ConfirmBackupEmailPageProps) {
  await requireIdentity();
  const [{ token }, t] = await Promise.all([searchParams, getTranslations("Security")]);
  return (
    <>
      <AuthPageTitle title={t("confirmBackupTitle")} />
      <ConfirmBackupEmail token={parseLinkToken(token)} />
    </>
  );
}
