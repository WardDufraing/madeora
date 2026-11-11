import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getHomeClosureSummary } from "@/activity/server";
import { parseAccountChangeAction } from "@/auth/google-reauth";
import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { getAccountSecurity } from "@/auth/security-server";
import { verifiedTotpFactor } from "@/auth/two-factor";
import { FormAlert } from "@/components/auth/form-alert";
import { CloseHome } from "@/components/deletion/close-home";
import { HOME_UNAVAILABLE_PATH, loadHomeForPage } from "@/components/homes/home-page";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";

interface ClosePageProps {
  readonly params: Promise<{ readonly homeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: ClosePageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Deletion"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("closeTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

/**
 * Closing a Home (S40; spec "Confirmed Home deletion and recovery", the "close" path of
 * "Confirmed guided transfer-or-close for departing Home Owner"). The Owner only: what closing
 * does (counts only, no one's data), then the Home's name and a fresh "confirm it's you".
 */
export default async function CloseHomePage({ params, searchParams }: ClosePageProps) {
  await requireIdentity();
  const { homeId } = await params;
  const [context, t, tHomes, query, user, security] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Deletion"),
    getTranslations("Homes"),
    searchParams,
    getVerifiedUser(),
    getAccountSecurity(),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, membership } = context;
  if (membership.role !== "owner") redirect(HOME_UNAVAILABLE_PATH);
  if (!user) return null;
  const summary = await getHomeClosureSummary(home.id);
  const hasPassword = security.status === "ok" ? security.value.hasPassword : true;

  return (
    <>
      <PageHeader title={t("closeTitle", { home: home.name })} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`/homes/${home.id}/leave`} className="font-medium text-accent-fg underline">
          {t("closeTransferInstead")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        <Card title={t("closeWhatTitle")}>
          <ul className="flex list-disc flex-col gap-2 ps-5 text-body">
            <li>{t("closeWhatAccess")}</li>
            <li>{t("closeWhatNotice")}</li>
            <li>{t("closeWhatInvitations")}</li>
            <li>{t("closeWhatRestore")}</li>
            <li>{t("closeWhatPurge")}</li>
            <li>{t("closeWhatPersonal")}</li>
            <li>{t("closeWhatNotLeaving")}</li>
          </ul>
        </Card>
        <Card title={t("closeAffectsTitle")}>
          {summary.status === "ok" ? (
            <ul
              className="flex list-disc flex-col gap-2 ps-5 text-body"
              data-testid="close-summary"
            >
              <li>{t("closeAffectsMembers", { count: summary.value.members })}</li>
              <li>{t("closeAffectsInvitations", { count: summary.value.invitations })}</li>
              <li>{t("closeAffectsCalendars", { count: summary.value.sharedCalendars })}</li>
            </ul>
          ) : (
            <FormAlert tone="error">{t("unavailable")}</FormAlert>
          )}
        </Card>
        <Card title={t("closeConfirmTitle")}>
          <CloseHome
            homeId={home.id}
            homeName={home.name}
            email={user.email ?? ""}
            userId={user.id}
            twoFactor={verifiedTotpFactor(user) !== null}
            hasPassword={hasPassword}
            confirmed={parseAccountChangeAction(query.confirmed)}
          />
        </Card>
      </div>
    </>
  );
}
