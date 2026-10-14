import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { parseTokenHash } from "@/auth/schemas";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../auth-page-title";

interface ResetPasswordPageProps {
  readonly searchParams: Promise<{ readonly token_hash?: string | string[] }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Auth");
  return { title: await pageTitle(t("resetTitle")) };
}

/**
 * Reached from the reset email, with a one-time token. Without one it shows the "incomplete link"
 * message; changing the password while signed in is a separate flow (S37).
 */
export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const [{ token_hash: tokenHash }, t] = await Promise.all([searchParams, getTranslations("Auth")]);
  return (
    <>
      <AuthPageTitle title={t("resetTitle")} />
      <ResetPasswordForm tokenHash={parseTokenHash(tokenHash)} />
    </>
  );
}
