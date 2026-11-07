import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { StartAccountRecovery } from "@/components/security/account-recovery";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("AccountRecovery");
  return { title: await pageTitle(t("title")) };
}

/** Lost both the password and the sign-in mailbox (S37): starts recovery via the backup address. */
export default async function AccountRecoveryPage() {
  const t = await getTranslations("AccountRecovery");
  return (
    <>
      <AuthPageTitle title={t("title")} />
      <StartAccountRecovery />
    </>
  );
}
