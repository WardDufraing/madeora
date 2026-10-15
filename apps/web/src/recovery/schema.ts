import { z } from "zod";

/**
 * Client-safe request schemas for verified Home ownership recovery (S12b). The server parses every
 * body with these again, and the database functions check everything once more under the Home's
 * lock. Error messages are keys into the `Recovery` messages.
 */

/** Text people write, trimmed, between `min` and `max` characters. */
function writtenText(min: number, max: number) {
  return z.string().trim().min(min, { message: "tooShort" }).max(max, { message: "tooLong" });
}

export const statementLimits = { min: 50, max: 4000 } as const;
export const reasonLimits = { min: 10, max: 2000 } as const;
export const appealLimits = { min: 10, max: 4000 } as const;
export const staffNotesLimits = { min: 10, max: 2000 } as const;

export const recoveryRequestSchema = z.strictObject({
  /** Private to Madeora staff: why the Owner cannot be reached and how staff can verify you. */
  statement: writtenText(statementLimits.min, statementLimits.max),
  /** Generated once per form, so a retry returns the same request. */
  requestId: z.uuid(),
});
export type RecoveryRequestInput = z.infer<typeof recoveryRequestSchema>;
/** The form's own fields (the request id is added on submit). */
export const recoveryStatementSchema = recoveryRequestSchema.pick({ statement: true });
export type RecoveryStatementValues = z.infer<typeof recoveryStatementSchema>;

export const recoveryObjectionSchema = z.strictObject({
  reason: writtenText(reasonLimits.min, reasonLimits.max),
});
export type RecoveryObjectionInput = z.infer<typeof recoveryObjectionSchema>;

export const recoveryAppealSchema = z.strictObject({
  reason: writtenText(appealLimits.min, appealLimits.max),
});
export type RecoveryAppealInput = z.infer<typeof recoveryAppealSchema>;

/** What the person who asked can do with their own request. */
export const claimantActions = ["withdraw", "accept"] as const;
export type ClaimantAction = (typeof claimantActions)[number];

export const staffActions = ["start_review", "approve", "pause", "resume", "reject"] as const;
export type StaffAction = (typeof staffActions)[number];
export const formerOwnerOutcomes = ["member", "removed"] as const;
export type FormerOwnerOutcome = (typeof formerOwnerOutcomes)[number];

/** Actions that must say why: approving, pausing and rejecting change someone's Home. */
export function staffActionNeedsNotes(action: StaffAction): boolean {
  return action === "approve" || action === "pause" || action === "reject";
}

export const staffDecisionSchema = z
  .strictObject({
    action: z.enum(staffActions),
    notes: z.string().trim().max(staffNotesLimits.max, { message: "tooLong" }),
    formerOwnerOutcome: z.enum(formerOwnerOutcomes).nullable(),
  })
  .superRefine((value, context) => {
    if (staffActionNeedsNotes(value.action) && value.notes.length < staffNotesLimits.min) {
      context.addIssue({ code: "custom", path: ["notes"], message: "tooShort" });
    }
    if (value.action === "approve" && value.formerOwnerOutcome === null) {
      context.addIssue({ code: "custom", path: ["formerOwnerOutcome"], message: "required" });
    }
  });
export type StaffDecisionInput = z.infer<typeof staffDecisionSchema>;

export const staffAppealCloseSchema = z.strictObject({
  notes: writtenText(staffNotesLimits.min, staffNotesLimits.max),
});
export type StaffAppealCloseInput = z.infer<typeof staffAppealCloseSchema>;

/** How a case looks from the outside (`private.recovery_state`). */
export const recoveryStates = [
  "submitted",
  "in_review",
  "approved",
  "ready",
  "paused",
  "completed",
  "rejected",
  "withdrawn",
  "cancelled",
  "owner_returned",
  "invalid",
] as const;
export type RecoveryState = (typeof recoveryStates)[number];

export const openRecoveryStates: readonly RecoveryState[] = [
  "submitted",
  "in_review",
  "approved",
  "ready",
  "paused",
];
