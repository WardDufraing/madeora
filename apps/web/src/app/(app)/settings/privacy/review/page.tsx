import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { PrivacyItemList } from "@/components/privacy/privacy-item-list";
import { PrivacyReview } from "@/components/privacy/privacy-review";
import { PageHeader } from "@/components/shell/page-header";
import { pageTitle } from "@/i18n/page-title";
import { perReviewStep } from "@/privacy/catalogue";
import { privacyItems } from "@/privacy/items";
import { getPrivacyOverview, getPrivacyReview } from "@/privacy/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Privacy");
  return { title: await pageTitle(t("reviewTitle")) };
}

/**
 * Settings › Privacy › Guided review (S39): optional and resumable, one topic at a time with the
 * current values read fresh on every visit. Keep as is, Change setting (the existing control),
 * Back, Skip and Finish only move through the review; completing it changes no setting.
 */
export default async function PrivacyReviewPage() {
  await requireIdentity();
  const [t, overview, review] = await Promise.all([
    getTranslations("Privacy"),
    getPrivacyOverview(),
    getPrivacyReview(),
  ]);
  const items = await privacyItems(overview);
  const state = review.status === "ok" ? review.value : null;
  return (
    <>
      <PageHeader title={t("reviewTitle")} />
      <p className="mb-4 max-w-2xl text-body text-fg-muted">{t("reviewIntro")}</p>
      <div className="max-w-3xl">
        <PrivacyReview
          state={state ? { step: state.step, completed: state.completedAt !== null } : null}
          unavailable={review.status === "unavailable"}
          panels={perReviewStep((step) => (
            <PrivacyItemList items={items.filter((item) => item.step === step)} />
          ))}
          changeLinks={perReviewStep(
            (step) => items.find((item) => item.step === step && item.href !== null)?.href ?? null,
          )}
        />
      </div>
    </>
  );
}
