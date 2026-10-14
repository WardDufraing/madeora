import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { OAuthCallback } from "@/components/auth/oauth-callback";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Auth");
  return { title: await pageTitle(t("googleCallbackTitle")) };
}

/**
 * Supabase Auth sends people here after Google (S08), for a sign-in or for linking Google in
 * Settings. Everything happens in the browser, which holds the one-time PKCE verifier.
 */
export default async function OAuthCallbackPage() {
  const t = await getTranslations("Auth");
  return (
    <>
      <AuthPageTitle title={t("googleCallbackTitle")} />
      <OAuthCallback />
    </>
  );
}
