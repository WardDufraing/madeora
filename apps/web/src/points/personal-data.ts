import "server-only";

import { z } from "zod";

import { memberPeriods, personalEntryKinds, personalRewardBlocks } from "@madeora/domain/points";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { zonedParts } from "@/chores/format";
import type { Read } from "@/chores/data";
import { logChores } from "@/chores/log";
import { getEffectiveTimeZone, getRegionalFormats } from "@/preferences/server";
import { dateOnlySchema } from "@/tasks/schema";

import type { PersonalPoints, PersonalRedemption, PersonalReward } from "./personal-api";

/**
 * Server reads of personal points and rewards (S28b), with the signed-in person's own session: the
 * database answers only the caller's own ledger and catalog, whatever they hold in any Home. Every
 * answer is checked against its shape; nothing is cached across requests.
 */

const timestamp = z.string();

const pointsSchema = z.object({
  totals: z.object({ available: z.int(), earned: z.int(), spent: z.int() }),
  entries: z.array(
    z.object({
      id: z.uuid(),
      seq: z.int(),
      kind: z.enum(personalEntryKinds),
      amount: z.int(),
      attributedAt: timestamp,
      createdAt: timestamp,
      reason: z.string().nullable(),
      availableBefore: z.int(),
      availableAfter: z.int(),
      redemption: z.object({ id: z.uuid(), rewardName: z.string() }).nullable(),
      reverses: z.uuid().nullable(),
      reversed: z.boolean(),
      canReverse: z.boolean(),
    }),
  ),
  next: z.int().nullable(),
});

const rewardSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  cost: z.int(),
  enabled: z.boolean(),
  availableFrom: dateOnlySchema.nullable(),
  availableUntil: dateOnlySchema.nullable(),
  totalLimit: z.int().nullable(),
  periodLimit: z.int().nullable(),
  limitPeriod: z.enum(memberPeriods).nullable(),
  archived: z.boolean(),
  revision: z.int(),
  block: z.enum(personalRewardBlocks).nullable(),
  remaining: z.int().nullable(),
  periodUsed: z.int(),
  nextEligibleOn: dateOnlySchema.nullable(),
  canAfford: z.boolean(),
  redeemedCount: z.int(),
});

const redemptionSchema = z.object({
  id: z.uuid(),
  rewardId: z.uuid(),
  rewardName: z.string(),
  cost: z.int(),
  redeemedAt: timestamp,
  redeemedOn: dateOnlySchema,
  fulfillment: z.enum(["pending", "fulfilled", "unable"]),
  fulfillmentAt: timestamp.nullable(),
  fulfillmentNote: z.string().nullable(),
  resolution: z.enum(["refund", "replacement"]).nullable(),
  resolvedAt: timestamp.nullable(),
  resolutionNote: z.string().nullable(),
  replacement: z.string().nullable(),
  revision: z.int(),
  events: z.array(
    z.object({
      kind: z.enum([
        "redeemed",
        "fulfilled",
        "unable",
        "pending",
        "fulfillment_corrected",
        "refunded",
        "replacement",
      ]),
      at: timestamp,
      note: z.string().nullable(),
    }),
  ),
});

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  logChores(event, error.code);
  return { status: "unavailable" };
}

function parsed<T>(event: string, schema: z.ZodType<T>, data: unknown): Read<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    logChores(event, "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: result.data };
}

/**
 * The owner's local "today" and week start, for reward windows and period limits: their effective
 * timezone (the account's chosen zone, else this device's) and regional week start. Never a Home's.
 */
export async function personalClock(): Promise<{
  readonly today: string;
  readonly weekStart: "monday" | "saturday" | "sunday";
}> {
  const [zone, regional] = await Promise.all([getEffectiveTimeZone(), getRegionalFormats()]);
  return {
    today: zonedParts(new Date().toISOString(), zone.timeZone).date,
    weekStart: regional.effective.weekStart,
  };
}

export async function getPersonalPoints(
  before: number | null = null,
): Promise<Read<PersonalPoints>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_personal_points", {
    ...(before !== null ? { p_before: before } : {}),
  });
  if (error) return failed("personal_points.read_failed", error);
  return parsed("personal_points.read_shape", pointsSchema, data);
}

export async function listPersonalRewards(
  includeArchived = false,
): Promise<Read<PersonalReward[]>> {
  const [supabase, clock] = await Promise.all([createSupabaseServerClient(), personalClock()]);
  const { data, error } = await supabase.rpc("list_personal_rewards", {
    p_include_archived: includeArchived,
    p_today: clock.today,
    p_week_start: clock.weekStart,
  });
  if (error) return failed("personal_rewards.list_failed", error);
  return parsed("personal_rewards.list_shape", z.array(rewardSchema), data);
}

export async function listPersonalRedemptions(
  view: "all" | "open" = "all",
): Promise<Read<PersonalRedemption[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_personal_reward_redemptions", { p_view: view });
  if (error) return failed("personal_rewards.redemptions_failed", error);
  return parsed("personal_rewards.redemptions_shape", z.array(redemptionSchema), data);
}
