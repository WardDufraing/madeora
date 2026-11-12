import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { getAuthState } from "@/auth/identity";
import { CHILD_HOME_PATH, DEFAULT_SIGNED_IN_PATH } from "@/auth/redirects";
import { getChildSession } from "@/child-sign-in/server";
import { childSignInAvailable } from "@/child-sign-in/service";
import { FormAlert } from "@/components/auth/form-alert";
import { ChildSignInForm } from "@/components/child-sign-in/child-sign-in-form";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ChildSignIn");
  return { title: await pageTitle(t("signInTitle")) };
}

/**
 * Child sign-in with a username and password (S42). Children never need an email address; their
 * guardian creates the username and password and decides whether independent sign-in is allowed.
 */
export default async function ChildSignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly status?: string | string[] }>;
}) {
  const [state, params] = await Promise.all([getAuthState(), searchParams]);
  // A child whose session ended (or was turned off) stays here and signs in again.
  if (state.kind === "child" && (await getChildSession())) redirect(CHILD_HOME_PATH);
  if (state.kind !== "signed-out" && state.kind !== "child") redirect(DEFAULT_SIGNED_IN_PATH);
  const t = await getTranslations("ChildSignIn");
  return (
    <>
      <AuthPageTitle title={t("signInTitle")} />
      {params.status === "signed-out" || params.status === "ended" ? (
        <FormAlert tone="info" className="mb-4">
          {params.status === "ended" ? t("sessionEndedNotice") : t("signedOutNotice")}
        </FormAlert>
      ) : null}
      <p className="mb-5 text-body text-fg-muted">{t("signInIntro")}</p>
      {childSignInAvailable() ? (
        <ChildSignInForm />
      ) : (
        <FormAlert tone="info">{t("unavailable")}</FormAlert>
      )}
      <p className="mt-6 text-body">
        <Link href="/sign-in" className="font-medium text-accent-fg underline">
          {t("adultSignInLink")}
        </Link>
      </p>
    </>
  );
}
