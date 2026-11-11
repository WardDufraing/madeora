import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { PrivacyItemList } from "@/components/privacy/privacy-item-list";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";
import { REVIEW_STEPS } from "@/privacy/catalogue";
import { privacyItems } from "@/privacy/items";
import { getPrivacyOverview, getPrivacyReview } from "@/privacy/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Privacy");
  return { title: await pageTitle(t("title")) };
}

/**
 * Settings › Privacy (S39, spec "Confirmed central privacy dashboard and optional guided review"):
 * an overview of the person's own privacy posture, each item linked to the setting that stays
 * authoritative, plus the optional guided review and the data export. Opening it changes nothing.
 * Only the account holder sees it; a Household Display has no personal settings (S43).
 */
export default async function PrivacyPage() {
  await requireIdentity();
  const [t, tDeletion, tData, tCopies, overview, review] = await Promise.all([
    getTranslations("Privacy"),
    getTranslations("Deletion"),
    getTranslations("DataDeletion"),
    getTranslations("HomeCopies"),
    getPrivacyOverview(),
    getPrivacyReview(),
  ]);
  const items = await privacyItems(overview);
  const state = review.status === "ok" ? review.value : null;

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4 max-w-2xl text-body text-fg-muted">{t("intro")}</p>
      <div className="flex max-w-3xl flex-col gap-6">
        <Card title={t("reviewCardTitle")} description={t("reviewCardHint")}>
          <p className="mb-3 text-helper text-fg-muted" data-testid="privacy-review-state">
            {state === null
              ? t("reviewNotStarted")
              : state.completedAt
                ? t("reviewCompleted")
                : t("reviewInProgress", {
                    step: REVIEW_STEPS.indexOf(state.step) + 1,
                    total: REVIEW_STEPS.length,
                  })}
          </p>
          <Link
            href="/settings/privacy/review"
            className="text-body font-medium text-accent-fg underline"
            data-testid="privacy-review-link"
          >
            {state !== null && state.completedAt === null ? t("reviewResume") : t("reviewStart")}
          </Link>
        </Card>
        {REVIEW_STEPS.map((step) => (
          <Card key={step} title={t(`step.${step}`)} description={t(`stepHint.${step}`)}>
            <PrivacyItemList items={items.filter((item) => item.step === step)} />
            {step === "data_rights" ? (
              <Link
                href="/settings/privacy/export"
                className="mt-2 inline-block text-body font-medium text-accent-fg underline"
                data-testid="privacy-export-link"
              >
                {t("exportLink")}
              </Link>
            ) : null}
            {step === "data_rights" ? (
              <p className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                <Link
                  href="/settings/closed-homes"
                  className="text-body font-medium text-accent-fg underline"
                  data-testid="privacy-closed-homes-link"
                >
                  {tDeletion("closedLink")}
                </Link>
                <Link
                  href="/settings/privacy/copies"
                  className="text-body font-medium text-accent-fg underline"
                  data-testid="privacy-copies-link"
                >
                  {tCopies("privacyLink")}
                </Link>
                <Link
                  href="/settings/privacy/delete-data"
                  className="text-body font-medium text-accent-fg underline"
                  data-testid="privacy-delete-data-link"
                >
                  {tData("privacyLink")}
                </Link>
                <Link
                  href="/settings/privacy/delete"
                  className="text-body font-medium text-accent-fg underline"
                  data-testid="privacy-delete-account-link"
                >
                  {tDeletion("accountLink")}
                </Link>
              </p>
            ) : null}
          </Card>
        ))}
        {overview.homes.status === "unavailable" || overview.security.status === "unavailable" ? (
          <FormAlert tone="error">{t("partlyUnavailable")}</FormAlert>
        ) : null}
      </div>
    </>
  );
}
