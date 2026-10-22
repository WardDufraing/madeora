import "server-only";

import { z } from "zod";

import {
  latePolicies,
  leaderboardPeriods,
  memberPeriods,
  rewardBlocks,
  type LeaderboardPeriod,
} from "@madeora/domain/points";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { Read } from "@/chores/data";
import { logChores } from "@/chores/log";
import { dateOnlySchema } from "@/tasks/schema";

import type {
  ChorePoints,
  Leaderboard,
  OccurrencePoints,
  PointAccountRow,
  PointLedger,
  PointSummary,
  Redemption,
  RedemptionView,
  Reward,
  WeeklyPoints,
} from "./api";

/**
 * Server reads of points and rewards (S23), with the signed-in person's own session: the database
 * answers only what they may see (their own account; every account for points managers; a Home
 * they are not in is not found). Every answer is checked against its shape; nothing is cached
 * across requests.
 */

const person = z.object({ me: z.boolean(), member: z.uuid().nullable() }).nullable();
const timestamp = z.string();

const totals = z.object({
  available: z.int(),
  reserved: z.int(),
  balance: z.int(),
  earned: z.int(),
  spent: z.int(),
  owed: z.boolean(),
});

const week = z.object({ earned: z.int(), pending: z.int(), possible: z.int() });

const summarySchema = z.object({
  accountId: z.uuid().nullable(),
  totals,
  week: week.extend({ startsOn: dateOnlySchema, endsOn: dateOnlySchema }),
  participates: z.boolean(),
  target: z.int().nullable(),
  targetPaused: z.boolean(),
  shareTarget: z.boolean(),
  leaderboardEnabled: z.boolean(),
  defaultPeriod: z.enum(leaderboardPeriods),
  canManagePoints: z.boolean(),
  canManageRewards: z.boolean(),
  canApproveRewards: z.boolean(),
  pendingApprovals: z.int(),
  openFulfillment: z.int(),
  myPendingRequests: z.int(),
});

const entryKind = z.enum([
  "chore_award",
  "chore_reversal",
  "bonus",
  "correction",
  "manual_reversal",
  "redemption",
  "refund",
]);

const ledgerSchema = z.object({
  account: totals.extend({ id: z.uuid(), person, former: z.boolean() }).nullable(),
  entries: z.array(
    z.object({
      id: z.uuid(),
      seq: z.int(),
      kind: entryKind,
      amount: z.int(),
      late: z.boolean().nullable(),
      attributedAt: timestamp,
      createdAt: timestamp,
      reason: z.string().nullable(),
      actor: person,
      availableBefore: z.int(),
      availableAfter: z.int(),
      reservedAfter: z.int(),
      occurrence: z
        .object({ id: z.uuid(), title: z.string(), scheduledDate: dateOnlySchema })
        .nullable(),
      redemption: z.object({ id: z.uuid(), rewardName: z.string() }).nullable(),
      reverses: z.uuid().nullable(),
      reversed: z.boolean(),
      canReverse: z.boolean(),
    }),
  ),
  next: z.int().nullable(),
});

const accountsSchema = z.array(
  z
    .object({
      account_id: z.uuid().nullable(),
      member_id: z.uuid().nullable(),
      former: z.boolean(),
      totals,
    })
    .transform((row): PointAccountRow => ({
      accountId: row.account_id,
      memberId: row.member_id,
      former: row.former,
      totals: row.totals,
    })),
);

const leaderboardSchema = z.object({
  enabled: z.boolean(),
  period: z.enum(leaderboardPeriods),
  defaultPeriod: z.enum(leaderboardPeriods),
  startsOn: dateOnlySchema.nullable().optional(),
  endsOn: dateOnlySchema.nullable().optional(),
  participates: z.boolean().optional(),
  rows: z.array(
    z.object({
      member: z.uuid(),
      me: z.boolean(),
      earned: z.int(),
      completed: z.int(),
      rank: z.int(),
    }),
  ),
});

const weeklySchema = z.object({
  startsOn: dateOnlySchema,
  endsOn: dateOnlySchema,
  me: week.extend({ target: z.int().nullable() }),
  members: z
    .array(week.extend({ member: z.uuid(), me: z.boolean(), target: z.int().nullable() }))
    .nullable(),
  unassignedPossible: z.int().nullable(),
});

const rewardSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  cost: z.int(),
  requiresApproval: z.boolean(),
  enabled: z.boolean(),
  availableFrom: dateOnlySchema.nullable(),
  availableUntil: dateOnlySchema.nullable(),
  totalLimit: z.int().nullable(),
  memberLimit: z.int().nullable(),
  memberPeriod: z.enum(memberPeriods).nullable(),
  archived: z.boolean(),
  revision: z.int(),
  block: z.enum(rewardBlocks).nullable(),
  remaining: z.int().nullable(),
  myUsed: z.int(),
  nextEligibleOn: dateOnlySchema.nullable(),
  canAfford: z.boolean(),
  pendingCount: z.int().nullable(),
  redeemedCount: z.int().nullable(),
});

const fulfillment = z.enum(["pending", "fulfilled", "unable"]);

const redemptionSchema = z.object({
  id: z.uuid(),
  rewardId: z.uuid(),
  rewardName: z.string(),
  cost: z.int(),
  status: z.enum(["pending", "redeemed", "rejected", "cancelled"]),
  requester: person,
  requestedAt: timestamp,
  decidedAt: timestamp.nullable(),
  decidedBy: person,
  decisionReason: z.string().nullable(),
  departed: z.boolean(),
  redeemedAt: timestamp.nullable(),
  fulfillment: fulfillment.nullable(),
  fulfillmentAt: timestamp.nullable(),
  fulfillmentBy: person,
  fulfillmentNote: z.string().nullable(),
  resolution: z.enum(["refund", "replacement"]).nullable(),
  resolvedAt: timestamp.nullable(),
  resolutionNote: z.string().nullable(),
  replacement: z.string().nullable(),
  replacementResponsible: person,
  replacementStatus: fulfillment.nullable(),
  revision: z.int(),
  canApprove: z.boolean(),
  canCancel: z.boolean(),
  canFulfil: z.boolean(),
  canResolve: z.boolean(),
  canSetReplacement: z.boolean(),
  blocker: z.enum(["own_request", "no_reviewer"]).nullable(),
  events: z
    .array(
      z.object({ kind: z.string(), at: timestamp, note: z.string().nullable(), actor: person }),
    )
    .nullable(),
});

const latePolicy = z.enum(latePolicies);

const chorePointsSchema = z.object({
  points: z.int(),
  latePolicy,
  latePoints: z.int().nullable(),
  lateNow: z.boolean(),
  expectedNow: z.int(),
  chore: z.object({
    points: z.int(),
    latePolicy,
    latePoints: z.int().nullable(),
    revision: z.int(),
    scheduledOther: z.int().nullable(),
  }),
  pending: z.object({ person, amount: z.int(), late: z.boolean() }).nullable(),
  awarded: z.object({ person, amount: z.int(), late: z.boolean(), at: timestamp }).nullable(),
  entries: z.array(
    z.object({
      kind: entryKind,
      amount: z.int(),
      late: z.boolean().nullable(),
      createdAt: timestamp,
      person,
    }),
  ),
  canCorrect: z.boolean(),
  canCorrectAwarded: z.boolean(),
});

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  if (error.code === "42501" || error.code === "22023") return { status: "not-found" };
  logChores(event, error.code);
  return { status: "unavailable" };
}

/** Parses an answer; null from the database (not the caller's to see) is not found. */
function parsed<T>(event: string, schema: z.ZodType<T>, data: unknown): Read<T> {
  if (data === null) return { status: "not-found" };
  const result = schema.safeParse(data);
  if (!result.success) {
    logChores(event, "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: result.data };
}

const isId = (value: string) => z.uuid().safeParse(value).success;

export async function getPointSummary(homeId: string): Promise<Read<PointSummary>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_point_summary", { p_home_id: homeId });
  if (error) return failed("points.summary_failed", error);
  return parsed("points.summary_shape", summarySchema, data);
}

/** One page of a ledger: the caller's own (accountId null) or, for points managers, any account. */
export async function listPointEntries(
  homeId: string,
  accountId: string | null,
  before: number | null = null,
): Promise<Read<PointLedger>> {
  if (accountId !== null && !isId(accountId)) return { status: "not-found" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_point_entries", {
    p_home_id: homeId,
    ...(accountId !== null ? { p_account_id: accountId } : {}),
    ...(before !== null ? { p_before: before } : {}),
  });
  if (error) return failed("points.entries_failed", error);
  return parsed("points.entries_shape", ledgerSchema, data);
}

/** Every account with its totals (points managers); anyone else is answered not found. */
export async function listPointAccounts(homeId: string): Promise<Read<PointAccountRow[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_point_accounts", { p_home_id: homeId });
  if (error) return failed("points.accounts_failed", error);
  return parsed("points.accounts_shape", accountsSchema, data);
}

export async function getLeaderboard(
  homeId: string,
  period: LeaderboardPeriod | null,
): Promise<Read<Leaderboard>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_point_leaderboard", {
    p_home_id: homeId,
    ...(period !== null ? { p_period: period } : {}),
  });
  if (error) return failed("points.leaderboard_failed", error);
  return parsed("points.leaderboard_shape", leaderboardSchema, data);
}

export async function getWeeklyPoints(
  homeId: string,
  shared: boolean,
): Promise<Read<WeeklyPoints>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_weekly_points", {
    p_home_id: homeId,
    p_shared: shared,
  });
  if (error) return failed("points.weekly_failed", error);
  return parsed("points.weekly_shape", weeklySchema, data);
}

export async function listRewards(
  homeId: string,
  includeArchived = false,
): Promise<Read<Reward[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_rewards", {
    p_home_id: homeId,
    p_include_archived: includeArchived,
  });
  if (error) return failed("rewards.list_failed", error);
  return parsed("rewards.list_shape", z.array(rewardSchema), data);
}

export async function listRedemptions(
  homeId: string,
  view: RedemptionView,
): Promise<Read<Redemption[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_reward_redemptions", {
    p_home_id: homeId,
    p_view: view,
  });
  if (error) return failed("rewards.redemptions_failed", error);
  return parsed("rewards.redemptions_shape", z.array(redemptionSchema), data);
}

export async function getRedemption(redemptionId: string): Promise<Read<Redemption>> {
  if (!isId(redemptionId)) return { status: "not-found" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_reward_redemption", {
    p_redemption_id: redemptionId,
  });
  if (error) return failed("rewards.redemption_failed", error);
  return parsed("rewards.redemption_shape", redemptionSchema, data);
}

export async function getChorePoints(occurrenceId: string): Promise<Read<ChorePoints>> {
  if (!isId(occurrenceId)) return { status: "not-found" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_chore_points", {
    p_occurrence_id: occurrenceId,
  });
  if (error) return failed("points.chore_failed", error);
  return parsed("points.chore_shape", chorePointsSchema, data);
}

const occurrencePointsSchema = z.array(
  z.object({
    occurrence_id: z.uuid(),
    points: z.int(),
    late_policy: latePolicy,
    late_points: z.int().nullable(),
    awarded: z.int().nullable(),
  }),
);

/** Points of many occurrences of one Home, by occurrence id (cards, the pool, the schedule). */
export async function listChorePoints(
  homeId: string,
  occurrenceIds: readonly string[],
): Promise<Read<Map<string, OccurrencePoints>>> {
  if (occurrenceIds.length === 0) return { status: "ok", value: new Map() };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_points", {
    p_home_id: homeId,
    p_occurrence_ids: [...occurrenceIds],
  });
  if (error) return failed("points.chore_list_failed", error);
  const rows = parsed("points.chore_list_shape", occurrencePointsSchema, data);
  if (rows.status !== "ok") return rows;
  return {
    status: "ok",
    value: new Map(
      rows.value.map((row) => [
        row.occurrence_id,
        {
          points: row.points,
          latePolicy: row.late_policy,
          latePoints: row.late_points,
          awarded: row.awarded,
        },
      ]),
    ),
  };
}
