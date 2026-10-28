import type { MemberPeriod, PersonalEntryKind, PersonalRewardBlock } from "@madeora/domain/points";

/**
 * The personal points and rewards API (S28b; ADR 0036): endpoints and the shapes they answer.
 * Client-safe; the routes live under `app/api/v1/personal-*`, the server reads in
 * `./personal-data`. One ledger per account, read and changed by its owner only; nothing here
 * names a Home, and no Home endpoint ever carries these balances.
 */

export const PERSONAL_POINTS_ENDPOINT = "/api/v1/personal-points";
export const PERSONAL_POINT_ADJUSTMENTS_ENDPOINT = "/api/v1/personal-point-adjustments";
export const PERSONAL_POINT_ENTRIES_ENDPOINT = "/api/v1/personal-point-entries";
export const PERSONAL_REWARDS_ENDPOINT = "/api/v1/personal-rewards";
export const PERSONAL_REWARD_REDEMPTIONS_ENDPOINT = "/api/v1/personal-reward-redemptions";

export const PERSONAL_POINTS_PATH = "/points";
export const PERSONAL_REWARDS_PATH = "/rewards";

export interface PersonalTotals {
  /** The balance; nothing is ever reserved, so all of it can be spent. */
  readonly available: number;
  /** Credits, corrections and reversals. */
  readonly earned: number;
  /** Redemptions less refunds. */
  readonly spent: number;
}

export interface PersonalEntry {
  readonly id: string;
  readonly seq: number;
  readonly kind: PersonalEntryKind;
  readonly amount: number;
  readonly attributedAt: string;
  readonly createdAt: string;
  readonly reason: string | null;
  readonly availableBefore: number;
  readonly availableAfter: number;
  readonly redemption: { readonly id: string; readonly rewardName: string } | null;
  readonly reverses: string | null;
  readonly reversed: boolean;
  readonly canReverse: boolean;
}

export interface PersonalPoints {
  readonly totals: PersonalTotals;
  readonly entries: readonly PersonalEntry[];
  /** The `before` of the next page, or null. */
  readonly next: number | null;
}

export interface PersonalReward {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly cost: number;
  readonly enabled: boolean;
  readonly availableFrom: string | null;
  readonly availableUntil: string | null;
  readonly totalLimit: number | null;
  readonly periodLimit: number | null;
  readonly limitPeriod: MemberPeriod | null;
  readonly archived: boolean;
  readonly revision: number;
  readonly block: PersonalRewardBlock | null;
  readonly remaining: number | null;
  readonly periodUsed: number;
  readonly nextEligibleOn: string | null;
  readonly canAfford: boolean;
  readonly redeemedCount: number;
}

export type PersonalFulfillment = "pending" | "fulfilled" | "unable";

export interface PersonalRedemptionEvent {
  readonly kind:
    | "redeemed"
    | "fulfilled"
    | "unable"
    | "pending"
    | "fulfillment_corrected"
    | "refunded"
    | "replacement";
  readonly at: string;
  readonly note: string | null;
}

export interface PersonalRedemption {
  readonly id: string;
  readonly rewardId: string;
  readonly rewardName: string;
  readonly cost: number;
  readonly redeemedAt: string;
  readonly redeemedOn: string;
  readonly fulfillment: PersonalFulfillment;
  readonly fulfillmentAt: string | null;
  readonly fulfillmentNote: string | null;
  readonly resolution: "refund" | "replacement" | null;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
  readonly replacement: string | null;
  readonly revision: number;
  readonly events: readonly PersonalRedemptionEvent[];
}

export interface PersonalAdjustmentResult {
  readonly outcome: "preview" | "posted" | "exists" | "reversed";
  readonly preview: {
    readonly kind: "credit" | "correction" | "manual_reversal";
    readonly amount: number;
    readonly available: number;
    readonly availableAfter: number;
  } | null;
  readonly entryId: string | null;
}

export interface PersonalRedeemResult {
  readonly outcome: "preview" | "redeemed" | "exists";
  readonly detail: {
    readonly cost?: number;
    readonly available?: number;
    readonly availableAfter?: number;
    readonly id?: string;
  } | null;
}

export interface PersonalMutationResult {
  readonly outcome: string;
  readonly impact: Record<string, unknown> | null;
  readonly revision: number | null;
}
