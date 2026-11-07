import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { parseTokenHash } from "@/auth/schemas";
import { ConfirmEmailChange } from "@/components/security/confirm-email-change";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../../auth-page-title";

interface ConfirmEmailChangePageProps {
  readonly searchParams: Promise<{ readonly token_hash?: string | string[] }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Security");
  return { title: await pageTitle(t("confirmEmailTitle")) };
}

/** The link sent to a new account email opens this page (S37). Nothing happens until the button. */
export default async function ConfirmEmailChangePage({
  searchParams,
}: ConfirmEmailChangePageProps) {
  const [{ token_hash: tokenHash }, t] = await Promise.all([
    searchParams,
    getTranslations("Security"),
  ]);
  return (
    <>
      <AuthPageTitle title={t("confirmEmailTitle")} />
      <ConfirmEmailChange tokenHash={parseTokenHash(tokenHash)} />
    </>
  );
}
