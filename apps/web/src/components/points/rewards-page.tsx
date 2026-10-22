import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { serverPerson } from "@/components/vacations/vacations-page";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import type { Redemption, Reward } from "@/points/api";
import { getPointSummary, listRedemptions, listRewards } from "@/points/data";
import { pointsPath } from "@/points/format";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate, memberNames } from "@/tasks/format";

import { RedemptionActions } from "./redemption-actions";
import { ArchiveReward, RedeemReward, RewardForm } from "./reward-actions";

/**
 * A Home's rewards (S23): the catalog with cost, eligibility, window, remaining capacity and the
 * next eligible date, Redeem or Request; the person's own requests and redemptions; for reviewers
 * the approval queue (never their own requests); for rewards managers the catalog management and
 * the fulfillment queue with its resolutions. Every right is decided again by the database.
 */
export async function RewardsPage({
  home,
  focus,
}: {
  readonly home: { readonly id: string; readonly name: string };
  readonly focus: "catalog" | "approvals";
}) {
  const [t, formats, summary, members] = await Promise.all([
    getTranslations("Rewards"),
    getDateTimeFormats(),
    getPointSummary(home.id),
    listTaskMembers(home.id),
  ]);
  const header = (
    <>
      <PageHeader title={focus === "approvals" ? t("approvalsTitle") : t("title")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={pointsPath(home.id)} className="font-medium text-accent-fg underline">
          {t("pointsLink")}
        </Link>
      </p>
    </>
  );
  if (summary.status !== "ok" || members.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  const value = summary.value;
  const [rewards, mine, approvals, fulfillment] = await Promise.all([
    listRewards(home.id, value.canManageRewards),
    listRedemptions(home.id, "mine"),
    value.canApproveRewards ? listRedemptions(home.id, "approvals") : null,
    value.canManageRewards ? listRedemptions(home.id, "fulfillment") : null,
  ]);
  if (rewards.status !== "ok" || mine.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  const names = memberNames(members.value);
  const who = await serverPerson(names);

  const blockText = (reward: Reward): string | null => {
    switch (reward.block) {
      case null:
        return reward.canAfford ? null : t("blockAfford");
      case "member_limit":
        return reward.nextEligibleOn
          ? t("blockMemberLimitUntil", { date: formatTaskDate(reward.nextEligibleOn, formats) })
          : t("blockMemberLimit");
      default:
        return t(`block_${reward.block}`);
    }
  };

  const status = (redemption: Redemption): string => {
    if (redemption.status !== "redeemed") return t(`status_${redemption.status}`);
    if (redemption.resolution === "refund") return t("statusRefunded");
    if (redemption.resolution === "replacement") {
      return t(`statusReplacement_${redemption.replacementStatus ?? "pending"}`);
    }
    return t(`fulfillment_${redemption.fulfillment ?? "pending"}`);
  };

  const redemptionItem = (redemption: Redemption, showRequester: boolean) => (
    <li key={redemption.id} className="flex flex-col gap-2 p-4" data-testid="redemption">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-body font-semibold text-fg">
          <bdi>{redemption.rewardName}</bdi>
          <span className="ms-2 font-normal text-fg-muted">
            {t("costValue", { points: redemption.cost })}
          </span>
        </span>
        <span className="text-helper font-semibold text-fg" data-testid="redemption-status">
          {status(redemption)}
        </span>
      </div>
      <p className="flex flex-wrap gap-x-3 text-helper text-fg-muted">
        {showRequester ? (
          <span>{t("requestedBy", { person: who(redemption.requester) })}</span>
        ) : null}
        <span>{formatDateTime(redemption.requestedAt, formats)}</span>
        {redemption.departed ? <span>{t("departed")}</span> : null}
      </p>
      {redemption.decisionReason ? (
        <p className="break-words text-body text-fg">
          <span className="font-medium">{t("reasonLabel")}</span> {redemption.decisionReason}
        </p>
      ) : null}
      {redemption.replacement ? (
        <p className="break-words text-body text-fg">
          {t("replacementLine", {
            replacement: redemption.replacement,
            person: who(redemption.replacementResponsible),
          })}
        </p>
      ) : null}
      {redemption.blocker ? (
        <p className="text-helper font-semibold text-fg" data-testid="redemption-blocker">
          {t(`blocker_${redemption.blocker}`)}
        </p>
      ) : null}
      <RedemptionActions redemption={redemption} members={members.value} />
    </li>
  );

  const list = (items: readonly Redemption[], showRequester: boolean, testId: string) => (
    <ul
      className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
      data-testid={testId}
    >
      {items.map((item) => redemptionItem(item, showRequester))}
    </ul>
  );

  const approvalSection =
    approvals?.status === "ok" ? (
      <section aria-labelledby="reward-approvals-heading" className="flex flex-col gap-3">
        <h2 id="reward-approvals-heading" className="text-section-title font-semibold text-fg">
          {t("approvalsHeading", { count: approvals.value.length })}
        </h2>
        {approvals.value.length === 0 ? (
          <p className="text-body text-fg-muted">{t("approvalsEmpty")}</p>
        ) : (
          list(approvals.value, true, "reward-approvals")
        )}
      </section>
    ) : approvals !== null ? (
      <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
    ) : focus === "approvals" ? (
      <p className="text-body text-fg-muted">{t("approvalsNotReviewer")}</p>
    ) : null;

  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-8">
        <p className="text-body text-fg" data-testid="rewards-available">
          {t("availableLine", {
            available: value.totals.available,
            reserved: value.totals.reserved,
          })}
        </p>
        {focus === "approvals" ? approvalSection : null}
        <section aria-labelledby="rewards-catalog-heading" className="flex flex-col gap-3">
          <h2 id="rewards-catalog-heading" className="text-section-title font-semibold text-fg">
            {t("catalogHeading")}
          </h2>
          {value.canManageRewards ? <RewardForm homeId={home.id} reward={null} /> : null}
          {rewards.value.length === 0 ? (
            <EmptyState title={t("emptyTitle")} description={t("empty")} />
          ) : (
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="rewards-catalog"
            >
              {rewards.value.map((reward) => {
                const blocked = blockText(reward);
                return (
                  <li key={reward.id} className="flex flex-col gap-2 p-4" data-testid="reward">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-body font-semibold text-fg">
                        <bdi>{reward.name}</bdi>
                      </span>
                      <span className="text-body font-semibold text-fg" data-testid="reward-cost">
                        {t("costValue", { points: reward.cost })}
                      </span>
                    </div>
                    {reward.description ? (
                      <p className="whitespace-pre-wrap break-words text-body text-fg">
                        {reward.description}
                      </p>
                    ) : null}
                    <p className="flex flex-wrap gap-x-3 text-helper text-fg-muted">
                      {reward.requiresApproval ? <span>{t("needsApproval")}</span> : null}
                      {reward.availableFrom || reward.availableUntil ? (
                        <span>
                          {t("window", {
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
                        <span>{t("remaining", { count: reward.remaining })}</span>
                      ) : null}
                      {reward.memberLimit !== null && reward.memberPeriod ? (
                        <span>
                          {t("memberLimitLine", {
                            used: reward.myUsed,
                            limit: reward.memberLimit,
                            period: t(`memberPeriod_${reward.memberPeriod}`),
                          })}
                        </span>
                      ) : null}
                      {value.canManageRewards && !reward.enabled ? (
                        <span>{t("disabled")}</span>
                      ) : null}
                      {reward.archived ? <span>{t("archived")}</span> : null}
                      {reward.pendingCount !== null ? (
                        <span>
                          {t("managerCounts", {
                            pending: reward.pendingCount,
                            redeemed: reward.redeemedCount ?? 0,
                          })}
                        </span>
                      ) : null}
                    </p>
                    {blocked ? (
                      <p className="text-helper font-semibold text-fg" data-testid="reward-block">
                        {blocked}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      {reward.block === null && reward.canAfford ? (
                        <RedeemReward reward={reward} />
                      ) : null}
                      {value.canManageRewards ? (
                        <>
                          {!reward.archived ? (
                            <RewardForm homeId={home.id} reward={reward} />
                          ) : null}
                          <ArchiveReward reward={reward} />
                        </>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section aria-labelledby="rewards-mine-heading" className="flex flex-col gap-3">
          <h2 id="rewards-mine-heading" className="text-section-title font-semibold text-fg">
            {t("mineHeading")}
          </h2>
          {mine.value.length === 0 ? (
            <p className="text-body text-fg-muted">{t("mineEmpty")}</p>
          ) : (
            list(mine.value, false, "rewards-mine")
          )}
        </section>
        {focus === "catalog" ? approvalSection : null}
        {fulfillment?.status === "ok" ? (
          <section aria-labelledby="reward-fulfillment-heading" className="flex flex-col gap-3">
            <h2
              id="reward-fulfillment-heading"
              className="text-section-title font-semibold text-fg"
            >
              {t("fulfillmentHeading", { count: fulfillment.value.length })}
            </h2>
            {fulfillment.value.length === 0 ? (
              <p className="text-body text-fg-muted">{t("fulfillmentEmpty")}</p>
            ) : (
              list(fulfillment.value, true, "reward-fulfillment")
            )}
          </section>
        ) : fulfillment !== null ? (
          <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
        ) : null}
      </div>
    </>
  );
}
