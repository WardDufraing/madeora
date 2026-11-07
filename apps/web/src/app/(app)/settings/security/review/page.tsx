import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { SecurityReviewDone } from "@/components/account/security-review-done";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Lifecycle");
  return { title: await pageTitle(t("reviewTitle")) };
}

/**
 * The security review after a long absence (S38, spec "Confirmed long-term adult account
 * inactivity reminders and security review"): the sign-in address, sign-in methods, devices and
 * recent security activity, each a link to where it is managed. Nothing is forced: two-factor
 * sign-in stays optional, and elapsed time alone is never treated as a compromise.
 */
export default async function SecurityReviewPage() {
  await requireIdentity();
  const [t, user] = await Promise.all([getTranslations("Lifecycle"), getVerifiedUser()]);
  if (!user) return null;
  const link = "font-medium text-accent-fg underline";
  return (
    <>
      <PageHeader title={t("reviewTitle")} />
      <p className="mb-4 max-w-2xl text-body text-fg-muted">{t("reviewIntro")}</p>
      <div className="flex max-w-2xl flex-col gap-6">
        <Card>
          <ul className="flex flex-col gap-4 text-body">
            <li className="flex flex-col gap-1">
              <span>{t("reviewEmail")}</span>
              <bdi className="font-semibold">{user.email}</bdi>
              <Link href="/settings/security#email" className={link}>
                {t("reviewEmailLink")}
              </Link>
            </li>
            <li className="flex flex-col gap-1">
              <span>{t("reviewMethods")}</span>
              <Link href="/settings#sign-in-methods" className={link}>
                {t("reviewMethodsLink")}
              </Link>
            </li>
            <li className="flex flex-col gap-1">
              <span>{t("reviewSessions")}</span>
              <Link href="/settings/security#sessions" className={link}>
                {t("reviewSessionsLink")}
              </Link>
            </li>
            <li className="flex flex-col gap-1">
              <span>{t("reviewActivity")}</span>
              <Link href="/settings/security/activity" className={link}>
                {t("reviewActivityLink")}
              </Link>
            </li>
          </ul>
        </Card>
        <SecurityReviewDone />
      </div>
    </>
  );
}
