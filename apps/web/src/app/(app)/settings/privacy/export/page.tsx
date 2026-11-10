import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { parseAccountChangeAction } from "@/auth/google-reauth";
import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { getAccountSecurity } from "@/auth/security-server";
import { verifiedTotpFactor } from "@/auth/two-factor";
import { FormAlert } from "@/components/auth/form-alert";
import { DataExport } from "@/components/privacy/data-export";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { listMyHomes } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats } from "@/invitations/server";
import { toExportRows } from "@/privacy/rows";
import { listMyExports } from "@/privacy/server";
import { storageEnabled } from "@/storage/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Privacy");
  return { title: await pageTitle(t("exportTitle")) };
}

interface ExportPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Settings › Privacy › Export your data (S39). Only the account holder can see or download their
 * exports; Homes are listed only while the person belongs to them.
 */
export default async function ExportPage({ searchParams }: ExportPageProps) {
  await requireIdentity();
  const [t, params, formats, user, security, homes, exports, locale] = await Promise.all([
    getTranslations("Privacy"),
    searchParams,
    getDateTimeFormats(),
    getVerifiedUser(),
    getAccountSecurity(),
    listMyHomes(),
    listMyExports("personal"),
    getLocale(),
  ]);
  if (!user) return null;
  const myHomes = homes.status === "ok" ? homes.homes : [];
  const nameOf = new Map(myHomes.map((home) => [home.id, home.name]));

  return (
    <>
      <PageHeader title={t("exportTitle")} />
      <p className="mb-2 max-w-2xl text-body text-fg-muted">{t("exportIntro")}</p>
      <p className="mb-4">
        <Link href="/settings/privacy" className="text-body font-medium text-accent-fg underline">
          {t("backToPrivacy")}
        </Link>
      </p>
      <div className="flex max-w-3xl flex-col gap-6">
        {exports.status === "unavailable" || homes.status === "unavailable" ? (
          <FormAlert tone="error">{t("unavailable")}</FormAlert>
        ) : null}
        <Card title={t("requestTitle")} description={t("requestHint")}>
          <DataExport
            email={user.email ?? ""}
            userId={user.id}
            twoFactor={verifiedTotpFactor(user) !== null}
            hasPassword={security.status === "ok" ? security.value.hasPassword : true}
            confirmed={parseAccountChangeAction(params.confirmed)}
            storageOn={storageEnabled()}
            homes={myHomes.map((home) => ({ id: home.id, name: home.name }))}
            exports={
              exports.status === "ok" ? toExportRows(exports.value, formats, locale, nameOf) : []
            }
          />
        </Card>
      </div>
    </>
  );
}
