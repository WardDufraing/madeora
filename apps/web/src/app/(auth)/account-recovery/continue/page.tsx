import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { parseLinkToken } from "@/auth/schemas";
import { ContinueAccountRecovery } from "@/components/security/account-recovery";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../../auth-page-title";

interface ContinueRecoveryPageProps {
  readonly searchParams: Promise<{ readonly token?: string | string[] }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("AccountRecovery");
  return { title: await pageTitle(t("continueTitle")) };
}

/** Opened from a link sent to the backup address (S37). Nothing happens until the form is sent. */
export default async function ContinueRecoveryPage({ searchParams }: ContinueRecoveryPageProps) {
  const [{ token }, t] = await Promise.all([searchParams, getTranslations("AccountRecovery")]);
  return (
    <>
      <AuthPageTitle title={t("continueTitle")} />
      <ContinueAccountRecovery token={parseLinkToken(token)} />
    </>
  );
}
