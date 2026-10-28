import { z } from "zod";

import { memberPeriods, POINTS_LIMITS } from "@madeora/domain/points";

import { nameSchema, normalizeShortText } from "@/chores/schema";
import { dateOnlySchema, plainTextSchema } from "@/tasks/schema";

import { pointsNoteSchema, pointsReasonSchema } from "./schema";

/**
 * Inputs of personal points and rewards (S28b), checked at the API boundary before the database
 * checks them again (balances, limits, revisions). Every object is strict, so a `homeId`, a `userId`
 * or any other owner is refused: the owner is always the signed-in session.
 */

const id = z.uuid();
const revisionSchema = z.int().min(1);

export const personalAdjustmentSchema = z
  .strictObject({
    id,
    kind: z.enum(["credit", "correction"]),
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

export const personalReversalSchema = z.strictObject({
  reason: pointsReasonSchema,
  dryRun: z.boolean(),
});

const personalRewardFieldsShape = {
  name: nameSchema(POINTS_LIMITS.rewardName),
  description: z
    .string()
    .transform((value) => (value.trim() === "" ? null : value))
    .pipe(plainTextSchema(POINTS_LIMITS.rewardDescription).nullable())
    .nullable(),
  cost: z.int().min(1).max(POINTS_LIMITS.cost),
  enabled: z.boolean(),
  availableFrom: dateOnlySchema.nullable(),
  availableUntil: dateOnlySchema.nullable(),
  totalLimit: z.int().min(1).max(POINTS_LIMITS.totalLimit).nullable(),
  periodLimit: z.int().min(1).max(POINTS_LIMITS.memberLimit).nullable(),
  limitPeriod: z.enum(memberPeriods).nullable(),
};

type PersonalRewardFields = {
  readonly availableFrom: string | null;
  readonly availableUntil: string | null;
  readonly periodLimit: number | null;
  readonly limitPeriod: string | null;
};
const windowValid = (reward: PersonalRewardFields) =>
  reward.availableFrom === null ||
  reward.availableUntil === null ||
  reward.availableUntil >= reward.availableFrom;
const periodLimitValid = (reward: PersonalRewardFields) =>
  (reward.periodLimit === null) === (reward.limitPeriod === null);

export const personalRewardCreateSchema = z
  .strictObject({ id, ...personalRewardFieldsShape })
  .refine(windowValid, { message: "endBeforeStart", path: ["availableUntil"] })
  .refine(periodLimitValid, { message: "required", path: ["limitPeriod"] });
export type PersonalRewardCreateInput = z.output<typeof personalRewardCreateSchema>;

export const personalRewardChangeSchema = z.discriminatedUnion("action", [
  z
    .strictObject({
      action: z.literal("edit"),
      expectedRevision: revisionSchema,
      dryRun: z.boolean(),
      ...personalRewardFieldsShape,
    })
    .refine(windowValid, { message: "endBeforeStart", path: ["availableUntil"] })
    .refine(periodLimitValid, { message: "required", path: ["limitPeriod"] }),
  z.strictObject({
    action: z.enum(["archive", "restore"]),
    expectedRevision: revisionSchema,
  }),
]);

/** The reward fields as the rpc functions take them. */
export function personalRewardFieldArgs(reward: Omit<PersonalRewardCreateInput, "id">) {
  return {
    p_name: reward.name,
    p_cost: reward.cost,
    p_enabled: reward.enabled,
    ...(reward.description !== null ? { p_description: reward.description } : {}),
    ...(reward.availableFrom !== null ? { p_available_from: reward.availableFrom } : {}),
    ...(reward.availableUntil !== null ? { p_available_until: reward.availableUntil } : {}),
    ...(reward.totalLimit !== null ? { p_total_limit: reward.totalLimit } : {}),
    ...(reward.periodLimit !== null ? { p_period_limit: reward.periodLimit } : {}),
    ...(reward.limitPeriod !== null ? { p_limit_period: reward.limitPeriod } : {}),
  };
}

export const personalRedeemSchema = z.strictObject({
  id,
  rewardId: id,
  /** The cost the owner saw; a changed cost is refused so they confirm the new one. */
  expectedCost: z.int().min(1).max(POINTS_LIMITS.cost),
  dryRun: z.boolean(),
});

/** What the owner chose instead of an Unable-to-fulfill reward: 1-200 characters; empty is none. */
const replacementSchema = z
  .string()
  .max(8 * POINTS_LIMITS.replacement, "tooLong")
  .transform(normalizeShortText)
  .pipe(plainTextSchema(POINTS_LIMITS.replacement).nullable());

export const personalRedemptionViewSchema = z.enum(["all", "open"]);

export const personalRedemptionChangeSchema = z.discriminatedUnion("action", [
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
      replacement: replacementSchema.nullable(),
      dryRun: z.boolean(),
    })
    .refine(
      (input) =>
        input.resolution === "refund" ? input.replacement === null : input.replacement !== null,
      { message: "required", path: ["replacement"] },
    ),
]);
export type PersonalRedemptionChangeInput = z.output<typeof personalRedemptionChangeSchema>;
