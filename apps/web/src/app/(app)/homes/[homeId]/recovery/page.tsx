import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { RecoveryClaimantActions } from "@/components/recovery/recovery-claimant-actions";
import { RecoveryNotice } from "@/components/recovery/recovery-notice";
import { RecoveryObjectionForm } from "@/components/recovery/recovery-objection-form";
import { RecoveryRequestForm } from "@/components/recovery/recovery-request-form";
import { claimantStateText, isOpenForOthers } from "@/components/recovery/recovery-state-text";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats } from "@/invitations/server";
import { getRecoveryStatus } from "@/recovery/server";

interface RecoveryPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
  readonly searchParams: Promise<{
    readonly requested?: string | string[];
    readonly objected?: string | string[];
  }>;
}

export async function generateMetadata({ params }: RecoveryPageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Recovery"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("pageTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

/**
 * Verified Home ownership recovery for one Home (S12b; spec "Confirmed verified Home ownership
 * recovery"). An eligible member asks Madeora staff to review a takeover when the Owner cannot be
 * reached, follows their request and accepts once it is approved and the objection period has
 * passed; other members object; the Owner says they still have access. Statements and objections
 * go to staff only and are never shown here.
 */
export default async function RecoveryPage({ params, searchParams }: RecoveryPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, tHomes, query] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Recovery"),
    getTranslations("Homes"),
    searchParams,
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, membership, permissions } = context;
  const [status, formats] = await Promise.all([getRecoveryStatus(home.id), getDateTimeFormats()]);
  const cases = status.status === "ok" ? status.cases : [];
  const own = cases.find((item) => item.viewer === "claimant");
  const ownOpen = own !== undefined && isOpenForOthers(own.state);
  const othersOpen = cases.filter(
    (item) => item.viewer === "member" && isOpenForOthers(item.state),
  );
  const canObject =
    permissions["home.recovery.object"] &&
    membership.role !== "owner" &&
    othersOpen.some((item) => !item.objected);

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={t("title")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`/homes/${home.id}`} className="font-medium text-accent-fg underline">
          {tHomes("backToHome")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        {query.requested === "1" && ownOpen ? (
          <FormAlert tone="success">{t("requestedNotice")}</FormAlert>
        ) : null}
        {query.objected === "1" ? (
          <FormAlert tone="success">{t("objectedNotice")}</FormAlert>
        ) : null}
        {status.status === "unavailable" ? (
          <FormAlert tone="error">{t("loadFailed")}</FormAlert>
        ) : null}

        {membership.role === "owner" ? (
          <>
            <RecoveryNotice homeId={home.id} homeName={home.name} accepted={false} />
            <Card title={t("ownerTitle")}>
              <p className="text-body text-fg">{t("ownerText")}</p>
            </Card>
          </>
        ) : null}

        {own ? (
          <Card title={t("yourRequestTitle")}>
            <div className="flex flex-col gap-4">
              <p className="text-body text-fg" data-testid="recovery-own-state">
                {claimantStateText(t, own, home.name, formats)}
              </p>
              {ownOpen ? (
                <RecoveryClaimantActions
                  homeId={home.id}
                  homeName={home.name}
                  recoveryId={own.id}
                  canAccept={own.state === "ready"}
                />
              ) : null}
            </div>
          </Card>
        ) : null}

        {canObject ? (
          <Card title={t("objectionTitle")} description={t("objectionIntro")}>
            <RecoveryObjectionForm homeId={home.id} />
          </Card>
        ) : othersOpen.length > 0 ? (
          <FormAlert tone="info">{t("memberNoticeObjected")}</FormAlert>
        ) : null}

        {permissions["home.recovery.request"] && !ownOpen ? (
          <Card title={t("requestTitle")}>
            <div className="flex flex-col gap-4">
              <p className="text-body text-fg">{t("requestIntro", { home: home.name })}</p>
              <p className="text-body font-medium text-fg">{t("requestBeforeTitle")}</p>
              <ul className="flex list-disc flex-col gap-1 ps-5 text-body text-fg">
                <li>{t("requestBeforeReset")}</li>
                <li>{t("requestBeforeContact")}</li>
                <li>{t("requestEligibility")}</li>
                <li>{t("requestWhatHappens")}</li>
                <li>{t("requestPrivacy")}</li>
              </ul>
              <RecoveryRequestForm homeId={home.id} />
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
