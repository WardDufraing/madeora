import { getTranslations } from "next-intl/server";
import Link from "next/link";

/**
 * Shown on every signed-in page after a long absence until the person has reviewed their security
 * (S38). Neutral wording: elapsed time is not a sign of compromise, and nothing is forced.
 */
export async function SecurityReviewBanner() {
  const t = await getTranslations("Lifecycle");
  return (
    <aside
      aria-label={t("reviewBannerLabel")}
      className="mb-4 mt-4 flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-4 text-body"
      data-testid="security-review-banner"
    >
      <p className="min-w-0 flex-1">{t("reviewBanner")}</p>
      <Link href="/settings/security/review" className="font-medium text-accent-fg underline">
        {t("reviewBannerLink")}
      </Link>
    </aside>
  );
}
