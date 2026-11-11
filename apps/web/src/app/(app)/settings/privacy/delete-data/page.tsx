import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { parseAccountChangeAction } from "@/auth/google-reauth";
import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { getAccountSecurity } from "@/auth/security-server";
import { verifiedTotpFactor } from "@/auth/two-factor";
import { FormAlert } from "@/components/auth/form-alert";
import { DeletePersonalData } from "@/components/privacy/delete-personal-data";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";
import { UNDELETABLE_CATEGORIES } from "@/privacy/catalogue";
import { getDeletionPreview } from "@/privacy/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("DataDeletion");
  return { title: await pageTitle(t("title")) };
}

interface DeleteDataPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Settings › Privacy › Delete data by category (S40 part 2). What can be deleted here (with counts),
 * what cannot and why, how this differs from the trash, leaving a Home and deleting the account, then
 * the category choice, impact preview and confirmation.
 */
export default async function DeleteDataPage({ searchParams }: DeleteDataPageProps) {
  await requireIdentity();
  const [t, params, user, security, preview] = await Promise.all([
    getTranslations("DataDeletion"),
    searchParams,
    getVerifiedUser(),
    getAccountSecurity(),
    getDeletionPreview(),
  ]);
  if (!user) return null;
  const hasPassword = security.status === "ok" ? security.value.hasPassword : true;

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4">
        <Link href="/settings/privacy" className="text-body font-medium text-accent-fg underline">
          {t("backToPrivacy")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        <Card title={t("aboutTitle")}>
          <ul className="flex list-disc flex-col gap-2 ps-5 text-body">
            <li>{t("aboutPermanent")}</li>
            <li>{t("aboutNotTrash")}</li>
            <li>{t("aboutHomes")}</li>
            <li>
              {t("aboutAccount")}{" "}
              <Link
                href="/settings/privacy/delete"
                className="font-medium text-accent-fg underline"
              >
                {t("aboutAccountLink")}
              </Link>
            </li>
          </ul>
        </Card>
        <Card title={t("notHereTitle")}>
          <ul
            className="flex list-disc flex-col gap-2 ps-5 text-body"
            data-testid="data-deletion-not-here"
          >
            {UNDELETABLE_CATEGORIES.map((category) => (
              <li key={category}>
                <span className="font-semibold">{t(`notHere.${category}`)}</span>
                {": "}
                {t(`notHereReason.${category}`)}
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t("chooseTitle")}>
          {preview.status === "ok" ? (
            <DeletePersonalData
              email={user.email ?? ""}
              userId={user.id}
              twoFactor={verifiedTotpFactor(user) !== null}
              hasPassword={hasPassword}
              confirmed={parseAccountChangeAction(params.confirmed)}
              counts={preview.value.categories}
              openExports={preview.value.openExports}
            />
          ) : (
            <FormAlert tone="error">{t("unavailable")}</FormAlert>
          )}
        </Card>
      </div>
    </>
  );
}
