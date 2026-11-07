import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { parseLinkToken } from "@/auth/schemas";
import { FinishAccountRecovery } from "@/components/security/account-recovery";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../../auth-page-title";

interface FinishRecoveryPageProps {
  readonly searchParams: Promise<{ readonly token?: string | string[] }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("AccountRecovery");
  return { title: await pageTitle(t("finishTitle")) };
}

/** Opened from a link sent to the backup address (S37). Nothing happens until the form is sent. */
export default async function FinishRecoveryPage({ searchParams }: FinishRecoveryPageProps) {
  const [{ token }, t] = await Promise.all([searchParams, getTranslations("AccountRecovery")]);
  return (
    <>
      <AuthPageTitle title={t("finishTitle")} />
      <FinishAccountRecovery token={parseLinkToken(token)} />
    </>
  );
}
