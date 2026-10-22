import { z } from "zod";

import { leaderboardPeriods, memberPeriods, POINTS_LIMITS } from "@madeora/domain/points";

import { nameSchema, normalizeShortText } from "@/chores/schema";

import { chorePointsSchema } from "./chore-points";
import { dateOnlySchema, plainTextSchema } from "@/tasks/schema";

/**
 * Inputs of points and rewards (S23), checked at the API boundary before the database checks them
 * again (rights, balances, capacity, revisions).
 */

const id = z.uuid();
const revisionSchema = z.int().min(1);

function shortText(max: number) {
  return z
    .string()
    .max(8 * max, "tooLong")
    .transform(normalizeShortText)
    .pipe(plainTextSchema(max).nullable());
}

/** An optional note or reason (up to 300 characters); empty is none. */
export const pointsNoteSchema = shortText(POINTS_LIMITS.reason);

/** A meaningful reason: 3-300 characters after whitespace runs read as one space. */
export const pointsReasonSchema = z
  .string()
  .max(8 * POINTS_LIMITS.reason, "tooLong")
  .transform(normalizeShortText)
  .pipe(
    plainTextSchema(POINTS_LIMITS.reason).refine(
      (value) => Array.from(value).length >= POINTS_LIMITS.reasonMin,
      "tooShort",
    ),
  );

export const occurrencePointsSchema = z.strictObject({
  expectedRevision: revisionSchema,
  setting: chorePointsSchema,
  reason: pointsNoteSchema.nullable(),
  dryRun: z.boolean(),
});

export const adjustmentSchema = z
  .strictObject({
    id,
    homeId: id,
    memberId: id,
    kind: z.enum(["bonus", "correction"]),
    amount: z
      .int()
      .min(-POINTS_LIMITS.adjustment)
      .max(POINTS_LIMITS.adjustment)
      .refine((value) => value !== 0, "invalid"),
    reason: pointsReasonSchema,
    dryRun: z.boolean(),
  })
  .refine((adjustment) => adjustment.kind === "correction" || adjustment.amount > 0, {
    message: "invalid",
    path: ["amount"],
  });

export const reversalSchema = z.strictObject({ reason: pointsReasonSchema, dryRun: z.boolean() });

/** The caller's own choices; each part optional. A target of null or 0 removes it. */
export const pointPreferencesSchema = z
  .strictObject({
    homeId: id,
    participates: z.boolean().optional(),
    target: z.int().min(0).max(POINTS_LIMITS.target).nullable().optional(),
    targetPaused: z.boolean().optional(),
    shareTarget: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.participates !== undefined ||
      input.target !== undefined ||
      input.targetPaused !== undefined ||
      input.shareTarget !== undefined,
    { message: "required" },
  );

export const pointSettingsSchema = z.strictObject({
  homeId: id,
  leaderboardEnabled: z.boolean(),
  defaultPeriod: z.enum(leaderboardPeriods),
});

export const leaderboardPeriodSchema = z.enum(leaderboardPeriods);

const rewardFieldsShape = {
  name: nameSchema(POINTS_LIMITS.rewardName),
  description: z
    .string()
    .transform((value) => (value.trim() === "" ? null : value))
    .pipe(plainTextSchema(POINTS_LIMITS.rewardDescription).nullable())
    .nullable(),
  cost: z.int().min(1).max(POINTS_LIMITS.cost),
  requiresApproval: z.boolean(),
  enabled: z.boolean(),
  availableFrom: dateOnlySchema.nullable(),
  availableUntil: dateOnlySchema.nullable(),
  totalLimit: z.int().min(1).max(POINTS_LIMITS.totalLimit).nullable(),
  memberLimit: z.int().min(1).max(POINTS_LIMITS.memberLimit).nullable(),
  memberPeriod: z.enum(memberPeriods).nullable(),
};

type RewardFields = {
  readonly availableFrom: string | null;
  readonly availableUntil: string | null;
  readonly memberLimit: number | null;
  readonly memberPeriod: string | null;
};
const windowValid = (reward: RewardFields) =>
  reward.availableFrom === null ||
  reward.availableUntil === null ||
  reward.availableUntil >= reward.availableFrom;
const memberLimitValid = (reward: RewardFields) =>
  (reward.memberLimit === null) === (reward.memberPeriod === null);

export const rewardCreateSchema = z
  .strictObject({ id, homeId: id, ...rewardFieldsShape })
  .refine(windowValid, { message: "endBeforeStart", path: ["availableUntil"] })
  .refine(memberLimitValid, { message: "required", path: ["memberPeriod"] });
export type RewardCreateInput = z.output<typeof rewardCreateSchema>;

export const rewardChangeSchema = z.discriminatedUnion("action", [
  z
    .strictObject({
      action: z.literal("edit"),
      expectedRevision: revisionSchema,
      dryRun: z.boolean(),
      ...rewardFieldsShape,
    })
    .refine(windowValid, { message: "endBeforeStart", path: ["availableUntil"] })
    .refine(memberLimitValid, { message: "required", path: ["memberPeriod"] }),
  z.strictObject({
    action: z.enum(["archive", "restore"]),
    expectedRevision: revisionSchema,
  }),
]);

/** The reward fields as the rpc functions take them. */
export function rewardFieldArgs(reward: Omit<RewardCreateInput, "id" | "homeId">) {
  return {
    p_name: reward.name,
    p_cost: reward.cost,
    p_requires_approval: reward.requiresApproval,
    p_enabled: reward.enabled,
    ...(reward.description !== null ? { p_description: reward.description } : {}),
    ...(reward.availableFrom !== null ? { p_available_from: reward.availableFrom } : {}),
    ...(reward.availableUntil !== null ? { p_available_until: reward.availableUntil } : {}),
    ...(reward.totalLimit !== null ? { p_total_limit: reward.totalLimit } : {}),
    ...(reward.memberLimit !== null ? { p_member_limit: reward.memberLimit } : {}),
    ...(reward.memberPeriod !== null ? { p_member_period: reward.memberPeriod } : {}),
  };
}

export const redeemSchema = z.strictObject({
  id,
  rewardId: id,
  /** The cost the member saw; a changed cost is refused so they confirm the new one. */
  expectedCost: z.int().min(1).max(POINTS_LIMITS.cost),
  dryRun: z.boolean(),
});

export const redemptionViewSchema = z.enum(["mine", "approvals", "fulfillment", "all"]);

export const redemptionChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("approve"),
    expectedRevision: revisionSchema,
    /** Approve although the reward became unavailable since the request. */
    confirm: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("reject"),
    expectedRevision: revisionSchema,
    reason: pointsNoteSchema.nullable(),
  }),
  z.strictObject({
    action: z.literal("cancel"),
    expectedRevision: revisionSchema,
    /** Required (3-300) when a rewards manager cancels someone else's request. */
    reason: pointsNoteSchema.nullable(),
  }),
  z.strictObject({
    action: z.literal("fulfillment"),
    expectedRevision: revisionSchema,
    state: z.enum(["pending", "fulfilled", "unable"]),
    note: pointsNoteSchema.nullable(),
  }),
  z
    .strictObject({
      action: z.literal("resolve"),
      expectedRevision: revisionSchema,
      resolution: z.enum(["refund", "replacement"]),
      note: pointsNoteSchema.nullable(),
      replacement: shortText(POINTS_LIMITS.replacement).nullable(),
      responsible: id.nullable(),
      dryRun: z.boolean(),
    })
    .refine(
      (input) =>
        input.resolution === "refund"
          ? input.replacement === null && input.responsible === null
          : input.replacement !== null && input.responsible !== null,
      { message: "required", path: ["replacement"] },
    ),
  z.strictObject({
    action: z.literal("replacement"),
    expectedRevision: revisionSchema,
    state: z.enum(["fulfilled", "unable"]),
    note: pointsNoteSchema.nullable(),
  }),
]);
export type RedemptionChangeInput = z.output<typeof redemptionChangeSchema>;
