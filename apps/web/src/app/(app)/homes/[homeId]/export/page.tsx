import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { parseAccountChangeAction } from "@/auth/google-reauth";
import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { getAccountSecurity } from "@/auth/security-server";
import { verifiedTotpFactor } from "@/auth/two-factor";
import { FormAlert } from "@/components/auth/form-alert";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { DataExport } from "@/components/privacy/data-export";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats } from "@/invitations/server";
import { toExportRows } from "@/privacy/rows";
import { getHomeExportAccess, listMyExports } from "@/privacy/server";
import { storageEnabled } from "@/storage/server";

interface HomeExportPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: HomeExportPageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const t = await getTranslations("Privacy");
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("homeExportPageTitle", { home: found.context.home.name })
        : t("homeExportTitle"),
    ),
  };
}

/**
 * A Home's data export (S39 part 2, spec "Confirmed Home data export permissions"): for the Owner
 * and the Administrators or Members the Owner allowed. It holds the Home-owned records the person
 * may see in Madeora, never personal items shared into the Home. Separate from the personal export
 * in Settings › Privacy. The database decides again on every request, build and download.
 */
export default async function HomeExportPage({ params, searchParams }: HomeExportPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, query, formats, user, security, access, exports, locale] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Privacy"),
    searchParams,
    getDateTimeFormats(),
    getVerifiedUser(),
    getAccountSecurity(),
    getHomeExportAccess(homeId),
    listMyExports("home"),
    getLocale(),
  ]);
  if (!context || !user) {
    return <ErrorState title={t("homeExportTitle")} description={t("unavailable")} />;
  }
  const { home } = context;
  const mine =
    exports.status === "ok" ? exports.value.filter((row) => row.homeIds.includes(home.id)) : [];

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={t("homeExportTitle")} />
      <p className="mb-2 max-w-2xl text-body text-fg-muted">
        {t("homeExportIntro", { home: home.name })}
      </p>
      <p className="mb-4">
        <Link
          href={`/homes/${home.id}/settings`}
          className="text-body font-medium text-accent-fg underline"
        >
          {t("backToHomeSettings")}
        </Link>
      </p>
      <div className="flex max-w-3xl flex-col gap-6">
        {access.status === "unavailable" || exports.status === "unavailable" ? (
          <FormAlert tone="error">{t("unavailable")}</FormAlert>
        ) : null}
        {access.status === "ok" && !access.value.canExport ? (
          <FormAlert tone="info">{t("homeNotPermitted")}</FormAlert>
        ) : null}
        {access.status === "ok" && access.value.canExport ? (
          <Card title={t("requestTitle")} description={t("homeRequestHint")}>
            <DataExport
              email={user.email ?? ""}
              userId={user.id}
              twoFactor={verifiedTotpFactor(user) !== null}
              hasPassword={security.status === "ok" ? security.value.hasPassword : true}
              confirmed={parseAccountChangeAction(query.confirmed)}
              storageOn={storageEnabled()}
              homes={[]}
              home={{ id: home.id, name: home.name }}
              exports={toExportRows(mine, formats, locale, new Map([[home.id, home.name]]))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
