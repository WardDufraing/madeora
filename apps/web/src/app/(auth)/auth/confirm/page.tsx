import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { parseTokenHash } from "@/auth/schemas";
import { ConfirmEmail } from "@/components/auth/confirm-email";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../../auth-page-title";

interface ConfirmPageProps {
  readonly searchParams: Promise<{ readonly token_hash?: string | string[] }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Auth");
  return { title: await pageTitle(t("confirmTitle")) };
}

/** The link in the confirmation email opens this page. Nothing happens until the button is used. */
export default async function ConfirmEmailPage({ searchParams }: ConfirmPageProps) {
  const [{ token_hash: tokenHash }, t] = await Promise.all([searchParams, getTranslations("Auth")]);
  return (
    <>
      <AuthPageTitle title={t("confirmTitle")} />
      <ConfirmEmail tokenHash={parseTokenHash(tokenHash)} />
    </>
  );
}
