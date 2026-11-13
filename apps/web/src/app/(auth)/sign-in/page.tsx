import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { getAuthState } from "@/auth/identity";
import { isGoogleSignInEnabled } from "@/auth/providers";
import {
  CHILD_HOME_PATH,
  DISPLAY_PATH,
  CHILD_SIGN_IN_PATH,
  REACTIVATE_PATH,
  safeNextPath,
  twoFactorPath,
} from "@/auth/redirects";
import { RememberDeviceChoice } from "@/components/account/remember-device-choice";
import { SigningInAs } from "@/components/account/signing-in-as";
import { AnnounceSignedOut } from "@/components/auth/announce-signed-out";
import { FormAlert } from "@/components/auth/form-alert";
import { GoogleSignIn, SignInDivider } from "@/components/auth/google-sign-in";
import { SignInForm } from "@/components/auth/sign-in-form";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../auth-page-title";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SignInPageProps {
  readonly searchParams: Promise<{
    readonly next?: string | string[];
    readonly status?: string;
    readonly account?: string | string[];
  }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Auth");
  return { title: await pageTitle(t("signInTitle")) };
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : undefined);
  const state = await getAuthState();
  if (state.kind === "signed-in") redirect(next);
  // Signed in with the first step only: the second step comes next (S37).
  if (state.kind === "second-factor") redirect(twoFactorPath(next));
  if (state.kind === "deactivated") redirect(REACTIVATE_PATH);
  if (state.kind === "child") redirect(CHILD_HOME_PATH);
  if (state.kind === "display") redirect(DISPLAY_PATH);

  const [t, tAccounts, tLifecycle, tDeletion, googleEnabled] = await Promise.all([
    getTranslations("Auth"),
    getTranslations("Accounts"),
    getTranslations("Lifecycle"),
    getTranslations("Deletion"),
    isGoogleSignInEnabled(),
  ]);
  return (
    <>
      <AuthPageTitle title={t("signInTitle")} />
      {params.status === "signed-out" ? (
        <>
          <AnnounceSignedOut />
          <FormAlert tone="info" className="mb-4">
            {t("signedOutNotice")}
          </FormAlert>
        </>
      ) : null}
      {params.status === "deactivated" ? (
        <>
          <AnnounceSignedOut />
          <FormAlert tone="info" className="mb-4">
            {tLifecycle("deactivatedNotice")}
          </FormAlert>
        </>
      ) : null}
      {params.status === "deletion_requested" ? (
        <>
          <AnnounceSignedOut />
          <FormAlert tone="info" className="mb-4">
            {tDeletion("requestedNotice")}
          </FormAlert>
        </>
      ) : null}
      {params.status === "deletion_canceled" ? (
        <>
          <AnnounceSignedOut />
          <FormAlert tone="success" className="mb-4">
            {tDeletion("canceledNotice")}
          </FormAlert>
        </>
      ) : null}
      {params.status === "reactivated" ? (
        <>
          <AnnounceSignedOut />
          <FormAlert tone="success" className="mb-4">
            {tLifecycle("reactivatedNotice")}
          </FormAlert>
        </>
      ) : null}
      {params.status === "switched" ? (
        <>
          <AnnounceSignedOut />
          <FormAlert tone="info" className="mb-4">
            {tAccounts("switchedNotice")}
          </FormAlert>
        </>
      ) : null}
      {typeof params.account === "string" && UUID.test(params.account) ? (
        <SigningInAs userId={params.account.toLowerCase()} />
      ) : null}
      {params.status === "password-changed" ? (
        <FormAlert tone="success" className="mb-4">
          {t("passwordChangedNotice")}
        </FormAlert>
      ) : null}
      <SignInForm next={next} />
      <div className="mt-4">
        <RememberDeviceChoice />
      </div>
      {googleEnabled ? (
        <>
          <SignInDivider />
          <GoogleSignIn next={next} />
        </>
      ) : null}
      <div className="mt-6 flex flex-col gap-2 text-body">
        <Link href="/accounts" className="font-medium text-accent-fg underline">
          {tAccounts("chooserLink")}
        </Link>
        <Link href="/forgot-password" className="font-medium text-accent-fg underline">
          {t("forgotPasswordLink")}
        </Link>
        <Link href={CHILD_SIGN_IN_PATH} className="font-medium text-accent-fg underline">
          {t("childSignInLink")}
        </Link>
        <p className="text-fg-muted">
          {t("noAccount")}{" "}
          <Link href="/sign-up" className="font-medium text-accent-fg underline">
            {t("signUpLink")}
          </Link>
        </p>
      </div>
    </>
  );
}
