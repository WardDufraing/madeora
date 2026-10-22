import { z } from "zod";

import { latePolicies, POINTS_LIMITS, validChorePoints } from "@madeora/domain/points";

/** No points, paid in full when late: what a chore earns unless a chore manager sets points. */
export const NO_CHORE_POINTS = { points: 0, latePolicy: "full", latePoints: null } as const;

/** A chore's points: 0-1000 and its late policy; a reduced policy names an amount up to them. */
export const chorePointsSchema = z
  .strictObject({
    points: z.int().min(0).max(POINTS_LIMITS.chorePoints),
    latePolicy: z.enum(latePolicies),
    latePoints: z.int().min(0).max(POINTS_LIMITS.chorePoints).nullable(),
  })
  .refine(validChorePoints, { message: "invalid", path: ["latePoints"] });
export type ChorePointsInput = z.output<typeof chorePointsSchema>;

/** The rpc arguments of a chore points setting. */
export function chorePointsArgs(setting: ChorePointsInput) {
  return {
    p_points: setting.points,
    p_late_policy: setting.latePolicy,
    ...(setting.latePoints !== null ? { p_late_points: setting.latePoints } : {}),
  };
}
