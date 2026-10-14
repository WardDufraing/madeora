import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { getVerifiedIdentity } from "@/auth/identity";
import { safeNextPath } from "@/auth/redirects";
import { AnnounceSignedOut } from "@/components/auth/announce-signed-out";
import { FormAlert } from "@/components/auth/form-alert";
import { SignInForm } from "@/components/auth/sign-in-form";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../auth-page-title";

interface SignInPageProps {
  readonly searchParams: Promise<{ readonly next?: string | string[]; readonly status?: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Auth");
  return { title: await pageTitle(t("signInTitle")) };
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : undefined);
  const identity = await getVerifiedIdentity();
  if (identity) redirect(next);

  const t = await getTranslations("Auth");
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
      {params.status === "password-changed" ? (
        <FormAlert tone="success" className="mb-4">
          {t("passwordChangedNotice")}
        </FormAlert>
      ) : null}
      <SignInForm next={next} />
      <div className="mt-6 flex flex-col gap-2 text-body">
        <Link href="/forgot-password" className="font-medium text-accent-fg underline">
          {t("forgotPasswordLink")}
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
