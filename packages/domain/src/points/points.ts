/**
 * Points and rewards (S23). Pure and framework-free, with dates as `YYYY-MM-DD` in the Home's
 * timezone (string order is date order). The database computes the same awards, blocks and ranks
 * and decides every right again (`private.chore_award`, `private.chore_late`, `private.reward_block`,
 * `public.get_point_leaderboard` and the `can` flags of `private.redemption_json` in
 * supabase/migrations/*_points_rewards.sql); this module only guides forms, previews and labels.
 */

/** The database's limits (`private.points_limit`). */
export const POINTS_LIMITS = {
  chorePoints: 1000,
  adjustment: 100000,
  cost: 100000,
  reason: 300,
  reasonMin: 3,
  rewardName: 80,
  rewardDescription: 500,
  replacement: 200,
  totalLimit: 10000,
  memberLimit: 100,
  rewards: 200,
  target: 100000,
} as const;

export const latePolicies = ["full", "reduced", "zero"] as const;
export type LatePolicy = (typeof latePolicies)[number];

export const memberPeriods = ["week", "month", "year", "ever"] as const;
export type MemberPeriod = (typeof memberPeriods)[number];

export const leaderboardPeriods = ["week", "month", "all"] as const;
export type LeaderboardPeriod = (typeof leaderboardPeriods)[number];

export interface ChorePointsSetting {
  readonly points: number;
  readonly latePolicy: LatePolicy;
  /** The reduced amount; null unless the policy is `reduced`. */
  readonly latePoints: number | null;
}

/** Whether a setting is valid: whole points 0-1000; a reduced policy names an amount up to them. */
export function validChorePoints(setting: ChorePointsSetting): boolean {
  const { points, latePolicy, latePoints } = setting;
  if (!Number.isInteger(points) || points < 0 || points > POINTS_LIMITS.chorePoints) return false;
  if ((latePolicy === "reduced") !== (latePoints !== null)) return false;
  return (
    latePoints === null || (Number.isInteger(latePoints) && latePoints >= 0 && latePoints <= points)
  );
}

/** The points a completion earns: the base value when on time; when late, the policy's amount. */
export function choreAward(setting: ChorePointsSetting, late: boolean): number {
  if (!late || setting.latePolicy === "full") return setting.points;
  if (setting.latePolicy === "reduced") return Math.min(setting.latePoints ?? 0, setting.points);
  return 0;
}

/** A completion is late when its Home-local date is after the due date; the review time never counts. */
export function isLateCompletion(dueDate: string, completedOn: string): boolean {
  return completedOn > dueDate;
}

/**
 * Competition ranking (1, 1, 3): by earned points, then by completed chores; equal on both share a
 * rank. The order within a rank is left to the caller (the interface sorts by name, implying
 * nothing).
 */
export function competitionRanks<T extends { readonly earned: number; readonly completed: number }>(
  rows: readonly T[],
): (T & { readonly rank: number })[] {
  const sorted = [...rows].sort((a, b) => b.earned - a.earned || b.completed - a.completed);
  let rank = 0;
  return sorted.map((row, index) => {
    const previous = sorted[index - 1];
    if (!previous || previous.earned !== row.earned || previous.completed !== row.completed) {
      rank = index + 1;
    }
    return { ...row, rank };
  });
}

/** Why a reward cannot be redeemed now, as `private.reward_block` reports it. */
export const rewardBlocks = [
  "archived",
  "disabled",
  "not_started",
  "ended",
  "sold_out",
  "member_limit",
] as const;
export type RewardBlock = (typeof rewardBlocks)[number];

/** Progress towards a weekly target, or null when there is none (a zero target means none). */
export function targetProgress(
  earned: number,
  target: number | null,
): { readonly earned: number; readonly target: number; readonly ratio: number } | null {
  if (target === null || target <= 0) return null;
  const clamped = Math.max(earned, 0);
  return { earned, target, ratio: Math.min(clamped / target, 1) };
}

export type RedemptionStatus = "pending" | "redeemed" | "rejected" | "cancelled";

export interface RedemptionFacts {
  readonly status: RedemptionStatus;
  /** The viewer asked for it. */
  readonly own: boolean;
}

export interface RewardViewer {
  readonly manageRewards: boolean;
  readonly approveRewards: boolean;
}

export type RedemptionAction = "approve" | "reject" | "cancel";

/**
 * Whether the viewer may act on a request (spec "Confirmed independent reviewer for reward
 * redemptions": a requester never approves or rejects their own request, whatever they hold;
 * "Confirmed cancellation of pending reward redemptions": the requester or a rewards manager
 * cancels while it is pending).
 */
export function canOnRedemption(
  viewer: RewardViewer,
  redemption: RedemptionFacts,
  action: RedemptionAction,
): boolean {
  if (redemption.status !== "pending") return false;
  if (action === "cancel") return redemption.own || viewer.manageRewards;
  return viewer.approveRewards && !redemption.own;
}
