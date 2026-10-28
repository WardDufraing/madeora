import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { ErrorState } from "@/components/ui/states";
import { PERSONAL_POINTS_PATH, PERSONAL_REWARDS_PATH } from "@/points/personal-api";
import { getPersonalPoints, listPersonalRewards } from "@/points/personal-data";

/**
 * The Personal points widget (S28b): the viewer's own available personal points and the cheapest of
 * their own rewards they can redeem now. Offered on the personal dashboard only, never on a Home
 * dashboard (and so never on a Household Display); it is not the Home "My points" widget.
 */
export async function PersonalPointsWidget() {
  const [t, points, rewards] = await Promise.all([
    getTranslations("PersonalPoints"),
    getPersonalPoints(),
    listPersonalRewards(),
  ]);
  if (points.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  const cheapest =
    rewards.status === "ok"
      ? (rewards.value
          .filter((reward) => reward.block === null && reward.canAfford)
          .sort((a, b) => a.cost - b.cost)[0] ?? null)
      : null;
  return (
    <div className="flex flex-col gap-2 text-body text-fg" data-testid="personal-points-widget">
      <p
        className="text-section-title font-semibold"
        data-testid="personal-points-widget-available"
      >
        {t("widgetAvailable", { points: points.value.totals.available })}
      </p>
      {cheapest ? (
        <p>
          {t("widgetCheapest", { cost: cheapest.cost })}{" "}
          <bdi className="font-semibold">{cheapest.name}</bdi>
        </p>
      ) : (
        <p className="text-fg-muted">{t("widgetNothingAffordable")}</p>
      )}
      <p className="flex flex-wrap gap-x-4 text-helper">
        <Link href={PERSONAL_POINTS_PATH} className="font-medium text-accent-fg underline">
          {t("widgetOpenPoints")}
        </Link>
        <Link href={PERSONAL_REWARDS_PATH} className="font-medium text-accent-fg underline">
          {t("widgetOpenRewards")}
        </Link>
      </p>
    </div>
  );
}
