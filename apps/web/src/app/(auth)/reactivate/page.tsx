import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { getAuthState } from "@/auth/identity";
import { DEFAULT_SIGNED_IN_PATH, twoFactorPath } from "@/auth/redirects";
import { ReactivateAccount } from "@/components/account/reactivate-account";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Lifecycle");
  return { title: await pageTitle(t("reactivateTitle")) };
}

/**
 * Where a deactivated account lands after signing in (S38). The sign-in itself, with two-factor
 * sign-in when enabled, is the proof of control; this page only asks to confirm coming back. The
 * session can do nothing else until then.
 */
export default async function ReactivatePage() {
  const state = await getAuthState();
  if (state.kind === "signed-out") redirect("/sign-in");
  if (state.kind === "second-factor") redirect(twoFactorPath(null));
  if (state.kind === "signed-in") redirect(DEFAULT_SIGNED_IN_PATH);
  const t = await getTranslations("Lifecycle");
  return (
    <>
      <AuthPageTitle title={t("reactivateTitle")} />
      <div className="flex flex-col gap-3 text-body">
        <p>{t("reactivateIntro")}</p>
        <p className="text-fg-muted">{t("reactivateKept")}</p>
        <p className="text-fg-muted">{t("reactivateNotRestored")}</p>
      </div>
      <ReactivateAccount />
    </>
  );
}
