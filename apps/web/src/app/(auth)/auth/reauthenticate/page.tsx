import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { GoogleReauthCallback } from "@/components/security/google-reauth-callback";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Security");
  return { title: await pageTitle(t("googleConfirmTitle")) };
}

/**
 * Supabase Auth sends people here after confirming a sensitive change with Google (S37). Only a
 * signed-in account can be confirming something; everything else happens in the browser, which
 * holds the one-time PKCE verifier.
 */
export default async function GoogleReauthPage() {
  await requireIdentity();
  const t = await getTranslations("Security");
  return (
    <>
      <AuthPageTitle title={t("googleConfirmTitle")} />
      <GoogleReauthCallback />
    </>
  );
}
