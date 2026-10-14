import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Auth");
  return { title: await pageTitle(t("forgotTitle")) };
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations("Auth");
  return (
    <>
      <AuthPageTitle title={t("forgotTitle")} />
      <ForgotPasswordForm />
      <p className="mt-6 text-body">
        <Link href="/sign-in" className="font-medium text-accent-fg underline">
          {t("backToSignIn")}
        </Link>
      </p>
    </>
  );
}
