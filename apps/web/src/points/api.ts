import type {
  LatePolicy,
  LeaderboardPeriod,
  MemberPeriod,
  RewardBlock,
} from "@madeora/domain/points";

import type { ChorePerson } from "@/chores/api";

/**
 * The points and rewards API (S23): endpoints and the shapes they answer. Client-safe; the routes
 * live under `app/api/v1`, the server reads in `./data`. Balances are private: a member sees their
 * own, points managers see every account, and nothing else (leaderboard, weekly overview, chore
 * pages) ever carries a balance, a reservation or a reason.
 */

export const POINTS_ENDPOINT = "/api/v1/points";
export const POINT_ACCOUNTS_ENDPOINT = "/api/v1/points/accounts";
export const POINT_ADJUSTMENTS_ENDPOINT = "/api/v1/point-adjustments";
export const POINT_ENTRIES_ENDPOINT = "/api/v1/point-entries";
export const POINT_PREFERENCES_ENDPOINT = "/api/v1/point-preferences";
export const POINT_SETTINGS_ENDPOINT = "/api/v1/point-settings";
export const LEADERBOARD_ENDPOINT = "/api/v1/leaderboard";
export const WEEKLY_POINTS_ENDPOINT = "/api/v1/weekly-points";
export const REWARDS_ENDPOINT = "/api/v1/rewards";
export const REWARD_REDEMPTIONS_ENDPOINT = "/api/v1/reward-redemptions";

export interface PointTotals {
  /** Balance less reserved; negative when chore reversals left points owed. */
  readonly available: number;
  /** Held by requests waiting for approval. */
  readonly reserved: number;
  readonly balance: number;
  /** Chore awards less reversals, bonuses and corrections. */
  readonly earned: number;
  /** Redemptions less refunds. */
  readonly spent: number;
  readonly owed: boolean;
}

/** Chore points of one member in one week. */
export interface WeekPoints {
  readonly earned: number;
  /** Submissions waiting for review, as they would be awarded. */
  readonly pending: number;
  /** Their open assigned occurrences due in the week, on time. */
  readonly possible: number;
}

export interface PointSummary {
  readonly accountId: string | null;
  readonly totals: PointTotals;
  readonly week: WeekPoints & { readonly startsOn: string; readonly endsOn: string };
  readonly participates: boolean;
  readonly target: number | null;
  readonly targetPaused: boolean;
  readonly shareTarget: boolean;
  readonly leaderboardEnabled: boolean;
  readonly defaultPeriod: LeaderboardPeriod;
  readonly canManagePoints: boolean;
  readonly canManageRewards: boolean;
  readonly canApproveRewards: boolean;
  readonly pendingApprovals: number;
  readonly openFulfillment: number;
  readonly myPendingRequests: number;
}

export type PointEntryKind =
  | "chore_award"
  | "chore_reversal"
  | "bonus"
  | "correction"
  | "manual_reversal"
  | "redemption"
  | "refund";

export interface PointEntry {
  readonly id: string;
  readonly seq: number;
  readonly kind: PointEntryKind;
  readonly amount: number;
  /** Chore awards only: completed after the due date. */
  readonly late: boolean | null;
  readonly attributedAt: string;
  readonly createdAt: string;
  readonly reason: string | null;
  readonly actor: ChorePerson | null;
  readonly availableBefore: number;
  readonly availableAfter: number;
  readonly reservedAfter: number;
  readonly occurrence: {
    readonly id: string;
    readonly title: string;
    readonly scheduledDate: string;
  } | null;
  readonly redemption: { readonly id: string; readonly rewardName: string } | null;
  readonly reverses: string | null;
  readonly reversed: boolean;
  readonly canReverse: boolean;
}

export interface PointLedger {
  readonly account:
    | (PointTotals & {
        readonly id: string;
        readonly person: ChorePerson | null;
        /** The holder left the Home; the account is preserved. */
        readonly former: boolean;
      })
    | null;
  readonly entries: readonly PointEntry[];
  /** The `before` cursor of the next page, or null. */
  readonly next: number | null;
}

/** One account in the points managers' overview. */
export interface PointAccountRow {
  readonly accountId: string | null;
  readonly memberId: string | null;
  readonly former: boolean;
  readonly totals: PointTotals;
}

export interface LeaderboardRow {
  readonly member: string;
  readonly me: boolean;
  readonly earned: number;
  readonly completed: number;
  readonly rank: number;
}

export interface Leaderboard {
  readonly enabled: boolean;
  readonly period: LeaderboardPeriod;
  readonly defaultPeriod: LeaderboardPeriod;
  readonly startsOn?: string | null | undefined;
  readonly endsOn?: string | null | undefined;
  readonly participates?: boolean | undefined;
  readonly rows: readonly LeaderboardRow[];
}

export interface WeeklyPoints {
  readonly startsOn: string;
  readonly endsOn: string;
  readonly me: WeekPoints & { readonly target: number | null };
  /** Shared overview only: every participating member (targets only when shared). */
  readonly members:
    | readonly (WeekPoints & {
        readonly member: string;
        readonly me: boolean;
        readonly target: number | null;
      })[]
    | null;
  readonly unassignedPossible: number | null;
}

export interface Reward {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly cost: number;
  readonly requiresApproval: boolean;
  readonly enabled: boolean;
  readonly availableFrom: string | null;
  readonly availableUntil: string | null;
  readonly totalLimit: number | null;
  readonly memberLimit: number | null;
  readonly memberPeriod: MemberPeriod | null;
  readonly archived: boolean;
  readonly revision: number;
  readonly block: RewardBlock | null;
  readonly remaining: number | null;
  readonly myUsed: number;
  readonly nextEligibleOn: string | null;
  readonly canAfford: boolean;
  /** Rewards managers only. */
  readonly pendingCount: number | null;
  readonly redeemedCount: number | null;
}

export type RedemptionStatus = "pending" | "redeemed" | "rejected" | "cancelled";
export type Fulfillment = "pending" | "fulfilled" | "unable";
export type RedemptionView = "mine" | "approvals" | "fulfillment" | "all";

export interface RedemptionEvent {
  readonly kind: string;
  readonly at: string;
  readonly note: string | null;
  readonly actor: ChorePerson | null;
}

export interface Redemption {
  readonly id: string;
  readonly rewardId: string;
  readonly rewardName: string;
  readonly cost: number;
  readonly status: RedemptionStatus;
  readonly requester: ChorePerson | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: ChorePerson | null;
  readonly decisionReason: string | null;
  readonly departed: boolean;
  readonly redeemedAt: string | null;
  readonly fulfillment: Fulfillment | null;
  readonly fulfillmentAt: string | null;
  readonly fulfillmentBy: ChorePerson | null;
  readonly fulfillmentNote: string | null;
  readonly resolution: "refund" | "replacement" | null;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
  readonly replacement: string | null;
  readonly replacementResponsible: ChorePerson | null;
  readonly replacementStatus: Fulfillment | null;
  readonly revision: number;
  readonly canApprove: boolean;
  readonly canCancel: boolean;
  readonly canFulfil: boolean;
  readonly canResolve: boolean;
  readonly canSetReplacement: boolean;
  /** Why a pending request cannot be reviewed by the viewer or by anyone. */
  readonly blocker: "own_request" | "no_reviewer" | null;
  readonly events: readonly RedemptionEvent[] | null;
}

/** The impact of a chore points change on the ledger (balances only for points managers). */
export interface ChorePointsChange {
  /** Who holds the award now (null: nobody) and its amount (0 when none). */
  readonly from: ChorePerson | null;
  readonly fromAmount: number;
  /** Who would hold it after the change, and the amount. */
  readonly to: ChorePerson | null;
  readonly toAmount: number;
  readonly late: boolean | null;
  /** Each affected account's change; `availableAfter` only for points managers. */
  readonly affected: readonly {
    readonly person: ChorePerson | null;
    readonly change: number;
    readonly availableAfter: number | null;
  }[];
  /** Previews only: whether the viewer may apply it. */
  readonly permitted?: boolean;
}

export interface ChorePoints {
  readonly points: number;
  readonly latePolicy: LatePolicy;
  readonly latePoints: number | null;
  readonly lateNow: boolean;
  readonly expectedNow: number;
  readonly chore: {
    readonly points: number;
    readonly latePolicy: LatePolicy;
    readonly latePoints: number | null;
    readonly revision: number;
    readonly scheduledOther: number | null;
  };
  readonly pending: {
    readonly person: ChorePerson | null;
    readonly amount: number;
    readonly late: boolean;
  } | null;
  readonly awarded: {
    readonly person: ChorePerson | null;
    readonly amount: number;
    readonly late: boolean;
    readonly at: string;
  } | null;
  readonly entries: readonly {
    readonly kind: PointEntryKind;
    readonly amount: number;
    readonly late: boolean | null;
    readonly createdAt: string;
    readonly person: ChorePerson | null;
  }[];
  readonly canCorrect: boolean;
  readonly canCorrectAwarded: boolean;
}

/** Points of one occurrence on cards and lists. */
export interface OccurrencePoints {
  readonly points: number;
  readonly latePolicy: LatePolicy;
  readonly latePoints: number | null;
  /** The award a completed occurrence carries now. */
  readonly awarded: number | null;
}

/** A preview of a manual adjustment or reversal. */
export interface AdjustmentPreview {
  readonly person: ChorePerson | null;
  readonly kind: "bonus" | "correction" | "manual_reversal";
  readonly amount: number;
  readonly available: number;
  readonly reserved: number;
  readonly availableAfter: number;
}

export interface AdjustmentResult {
  readonly outcome: "preview" | "posted" | "exists" | "reversed";
  readonly preview: AdjustmentPreview | null;
  readonly entryId: string | null;
}

export interface RedeemDetail {
  readonly cost: number;
  readonly requiresApproval: boolean;
  readonly available: number;
  readonly availableAfter: number;
  /** Requests only: someone other than the requester could approve it now. */
  readonly reviewerAvailable: boolean;
  readonly id?: string;
  readonly status?: RedemptionStatus;
  readonly nextEligibleOn?: string | null;
}

export interface RedeemResult {
  readonly outcome: "preview" | "redeemed" | "requested" | "exists";
  readonly detail: RedeemDetail | null;
}

export interface RewardMutationResult {
  readonly outcome: string;
  readonly impact: Record<string, unknown> | null;
  readonly revision: number | null;
}
