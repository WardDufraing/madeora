import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAuthState } from "@/auth/identity";
import { REACTIVATE_PATH, safeNextPath } from "@/auth/redirects";
import { describeDevice } from "@/auth/sessions";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { trustCookieName } from "@/auth/trusted-device";
import { verifiedTotpFactor } from "@/auth/two-factor";
import { TwoFactorChallenge } from "@/components/security/two-factor-challenge";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../../auth-page-title";

interface TwoFactorPageProps {
  readonly searchParams: Promise<{ readonly next?: string | string[] }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Security");
  return { title: await pageTitle(t("challengeTitle")) };
}

/**
 * The second sign-in step for accounts with two-factor sign-in (S37). Only a session that needs it
 * sees the form; signed-out visitors go to the sign-in page, finished sessions straight on. A
 * browser the account holder trusted skips the form: its cookie token, checked by the database
 * against the same browser and platform, marks this session as past the second factor.
 */
export default async function TwoFactorPage({ searchParams }: TwoFactorPageProps) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : undefined);
  const state = await getAuthState();
  if (state.kind === "signed-in") redirect(next);
  if (state.kind === "signed-out") redirect("/sign-in");
  if (state.kind === "deactivated") redirect(REACTIVATE_PATH);
  const factor = verifiedTotpFactor(state.user);
  if (!factor) redirect(next);

  const token = (await cookies()).get(trustCookieName(state.user.id))?.value;
  if (token) {
    const device = describeDevice((await headers()).get("user-agent"));
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.rpc("use_trusted_device", {
      p_token: token,
      p_browser: device.browser,
      p_platform: device.platform,
    });
    if (data === true) redirect(next);
  }

  const t = await getTranslations("Security");
  return (
    <>
      <AuthPageTitle title={t("challengeTitle")} />
      <TwoFactorChallenge factorId={factor.id} next={next} />
    </>
  );
}
