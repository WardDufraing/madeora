import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { getAuthState } from "@/auth/identity";
import { CHILD_HOME_PATH, DEFAULT_SIGNED_IN_PATH, twoFactorPath } from "@/auth/redirects";
import { ReactivateAccount } from "@/components/account/reactivate-account";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";

import { AuthPageTitle } from "../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Lifecycle");
  return { title: await pageTitle(t("reactivateTitle")) };
}

/**
 * Where a deactivated account, or one pending deletion (S40), lands after signing in (S38). The sign-in itself, with two-factor
 * sign-in when enabled, is the proof of control; this page only asks to confirm coming back. The
 * session can do nothing else until then.
 */
export default async function ReactivatePage() {
  const state = await getAuthState();
  if (state.kind === "signed-out") redirect("/sign-in");
  if (state.kind === "second-factor") redirect(twoFactorPath(null));
  if (state.kind === "signed-in") redirect(DEFAULT_SIGNED_IN_PATH);
  if (state.kind === "child") redirect(CHILD_HOME_PATH);
  const t = await getTranslations("Lifecycle");
  if (state.deletionPurgeAfter) {
    const [tDeletion, formats] = await Promise.all([
      getTranslations("Deletion"),
      getDateTimeFormats(),
    ]);
    return (
      <>
        <AuthPageTitle title={tDeletion("recoverTitle")} />
        <div className="flex flex-col gap-3 text-body" data-testid="account-pending-deletion">
          <p>
            {tDeletion("recoverIntro", {
              date: formatDateTime(state.deletionPurgeAfter, formats),
            })}
          </p>
          <p className="text-fg-muted">{tDeletion("recoverKept")}</p>
          <p className="text-fg-muted">{tDeletion("recoverNotRestored")}</p>
        </div>
        <ReactivateAccount deletion />
      </>
    );
  }
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
