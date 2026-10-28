import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import {
  PERSONAL_POINTS_PATH,
  type PersonalRedemption,
  type PersonalReward,
} from "@/points/personal-api";
import {
  getPersonalPoints,
  listPersonalRedemptions,
  listPersonalRewards,
} from "@/points/personal-data";
import { formatTaskDate } from "@/tasks/format";

import { PersonalRedemptionActions } from "./personal-redemption-actions";
import { PersonalArchive, PersonalRedeem, PersonalRewardForm } from "./personal-reward-actions";

/**
 * Personal rewards (S28b; self-defined only): the owner's own catalog with cost, window, limits and
 * Redeem, its management (new, edit with preview, archive, bring back), and their redemptions with
 * fulfillment and resolution. Read with their own session; nothing from a Home appears here.
 */
export async function PersonalRewardsPage({ archived }: { readonly archived: boolean }) {
  const [t, tr, formats, points, rewards, redemptions] = await Promise.all([
    getTranslations("PersonalPoints"),
    getTranslations("Rewards"),
    getDateTimeFormats(),
    getPersonalPoints(),
    listPersonalRewards(archived),
    listPersonalRedemptions("all"),
  ]);
  const header = (
    <>
      <PageHeader title={t("rewardsTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <span>{t("personalContext")}</span>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={PERSONAL_POINTS_PATH} className="font-medium text-accent-fg underline">
          {t("pointsLink")}
        </Link>
      </p>
    </>
  );
  if (points.status !== "ok" || rewards.status !== "ok" || redemptions.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={tr("loadFailedTitle")} description={tr("loadFailed")} />
      </>
    );
  }

  const blockText = (reward: PersonalReward): string | null => {
    switch (reward.block) {
      case null:
        return reward.canAfford ? null : tr("blockAfford");
      case "period_limit":
        return reward.nextEligibleOn
          ? t("blockPeriodLimitUntil", { date: formatTaskDate(reward.nextEligibleOn, formats) })
          : t("blockPeriodLimit");
      default:
        return tr(`block_${reward.block}`);
    }
  };

  const status = (redemption: PersonalRedemption): string => {
    if (redemption.resolution === "refund") return tr("statusRefunded");
    if (redemption.resolution === "replacement") return t("statusReplaced");
    return tr(`fulfillment_${redemption.fulfillment}`);
  };

  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-8">
        <p className="text-body text-fg" data-testid="personal-rewards-available">
          {t("availableLine", { available: points.value.totals.available })}
        </p>
        <section aria-labelledby="personal-catalog-heading" className="flex flex-col gap-3">
          <h2 id="personal-catalog-heading" className="text-section-title font-semibold text-fg">
            {t("catalogHeading")}
          </h2>
          <p className="text-helper text-fg-muted">{t("catalogHelp")}</p>
          <PersonalRewardForm reward={null} />
          {rewards.value.length === 0 ? (
            <EmptyState title={tr("emptyTitle")} description={t("empty")} />
          ) : (
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="personal-rewards"
            >
              {rewards.value.map((reward) => {
                const blocked = blockText(reward);
                return (
                  <li
                    key={reward.id}
                    className="flex flex-col gap-2 p-4"
                    data-testid="personal-reward"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-body font-semibold text-fg">
                        <bdi>{reward.name}</bdi>
                      </span>
                      <span className="text-body font-semibold text-fg">
                        {tr("costValue", { points: reward.cost })}
                      </span>
                    </div>
                    {reward.description ? (
                      <p className="whitespace-pre-wrap break-words text-body text-fg">
                        {reward.description}
                      </p>
                    ) : null}
                    <p className="flex flex-wrap gap-x-3 text-helper text-fg-muted">
                      {reward.availableFrom || reward.availableUntil ? (
                        <span>
                          {tr("window", {
                            from: reward.availableFrom
                              ? formatTaskDate(reward.availableFrom, formats)
                              : "",
                            until: reward.availableUntil
                              ? formatTaskDate(reward.availableUntil, formats)
                              : "",
                            hasFrom: reward.availableFrom ? "yes" : "no",
                            hasUntil: reward.availableUntil ? "yes" : "no",
                          })}
                        </span>
                      ) : null}
                      {reward.remaining !== null ? (
                        <span>{tr("remaining", { count: reward.remaining })}</span>
                      ) : null}
                      {reward.periodLimit !== null && reward.limitPeriod ? (
                        <span>
                          {t(`periodLimitLine_${reward.limitPeriod}`, {
                            used: reward.periodUsed,
                            limit: reward.periodLimit,
                          })}
                        </span>
                      ) : null}
                      {!reward.enabled ? <span>{tr("disabled")}</span> : null}
                      {reward.archived ? <span>{tr("archived")}</span> : null}
                    </p>
                    {blocked ? (
                      <p
                        className="text-helper font-semibold text-fg"
                        data-testid="personal-reward-block"
                      >
                        {blocked}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      {reward.block === null && reward.canAfford ? (
                        <PersonalRedeem reward={reward} />
                      ) : null}
                      {!reward.archived ? <PersonalRewardForm reward={reward} /> : null}
                      <PersonalArchive reward={reward} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <Link
            href={archived ? "/rewards" : "/rewards?archived=true"}
            className="text-body font-medium text-accent-fg underline"
          >
            {archived ? t("hideArchived") : t("showArchived")}
          </Link>
        </section>
        <section aria-labelledby="personal-redemptions-heading" className="flex flex-col gap-3">
          <h2
            id="personal-redemptions-heading"
            className="text-section-title font-semibold text-fg"
          >
            {t("redemptionsHeading")}
          </h2>
          {redemptions.value.length === 0 ? (
            <p className="text-body text-fg-muted">{tr("mineEmpty")}</p>
          ) : (
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="personal-redemptions"
            >
              {redemptions.value.map((redemption) => (
                <li
                  key={redemption.id}
                  className="flex flex-col gap-2 p-4"
                  data-testid="personal-redemption"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-body font-semibold text-fg">
                      <bdi>{redemption.rewardName}</bdi>
                      <span className="ms-2 font-normal text-fg-muted">
                        {tr("costValue", { points: redemption.cost })}
                      </span>
                    </span>
                    <span
                      className="text-helper font-semibold text-fg"
                      data-testid="personal-redemption-status"
                    >
                      {status(redemption)}
                    </span>
                  </div>
                  <p className="text-helper text-fg-muted">
                    {formatDateTime(redemption.redeemedAt, formats)}
                  </p>
                  {redemption.replacement ? (
                    <p className="break-words text-body text-fg">
                      {t("replacementLine", { replacement: redemption.replacement })}
                    </p>
                  ) : null}
                  {redemption.fulfillmentNote ? (
                    <p className="break-words text-body text-fg">
                      <span className="font-medium">{tr("reasonLabel")}</span>{" "}
                      {redemption.fulfillmentNote}
                    </p>
                  ) : null}
                  <PersonalRedemptionActions redemption={redemption} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
