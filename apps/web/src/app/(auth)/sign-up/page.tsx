import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { getVerifiedIdentity } from "@/auth/identity";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Auth");
  return { title: await pageTitle(t("signUpTitle")) };
}

export default async function SignUpPage() {
  const identity = await getVerifiedIdentity();
  if (identity) redirect("/");

  const t = await getTranslations("Auth");
  return (
    <>
      <AuthPageTitle title={t("signUpTitle")} />
      <SignUpForm />
      <p className="mt-6 text-body text-fg-muted">
        {t("haveAccount")}{" "}
        <Link href="/sign-in" className="font-medium text-accent-fg underline">
          {t("signInLink")}
        </Link>
      </p>
    </>
  );
}
