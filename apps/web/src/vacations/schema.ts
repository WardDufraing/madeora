import { z } from "zod";

import { VACATION_LIMITS } from "@madeora/domain/vacations";

import { normalizeShortText } from "@/chores/schema";
import { dateOnlySchema, plainTextSchema } from "@/tasks/schema";

/**
 * Inputs of Home vacations and absences (S22), checked at the API boundary before the database
 * checks them again (dates against the Home's today, rights, revisions).
 */

const id = z.uuid();

/** A vacation name: whitespace runs read as one space, trimmed; empty means the generic name. */
export const vacationNameSchema = z
  .string()
  .max(8 * VACATION_LIMITS.name, "tooLong")
  .transform(normalizeShortText)
  .pipe(plainTextSchema(VACATION_LIMITS.name).nullable());

export const absenceReasonSchema = z
  .string()
  .max(8 * VACATION_LIMITS.reason, "tooLong")
  .transform(normalizeShortText)
  .pipe(plainTextSchema(VACATION_LIMITS.reason).nullable());

const datesRefine = (stay: { readonly startsOn: string; readonly endsOn: string }) =>
  stay.endsOn >= stay.startsOn;

export const staySchema = z
  .strictObject({ memberId: id, startsOn: dateOnlySchema, endsOn: dateOnlySchema })
  .refine(datesRefine, { message: "endBeforeStart", path: ["endsOn"] });

const peopleSchema = z
  .array(staySchema)
  .min(1)
  .max(VACATION_LIMITS.people)
  .refine((people) => new Set(people.map((person) => person.memberId)).size === people.length, {
    message: "duplicate",
  });

const reminderDaysSchema = z.int().min(1).max(VACATION_LIMITS.reminderDays);

export const vacationCreateSchema = z.strictObject({
  id,
  homeId: id,
  name: vacationNameSchema.optional(),
  people: peopleSchema,
  reminderDays: reminderDaysSchema.nullable().optional(),
  dryRun: z.boolean(),
});
export type VacationCreateInput = z.output<typeof vacationCreateSchema>;

const revisionSchema = z.int().min(1);

export const vacationChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("rename"),
    expectedRevision: revisionSchema,
    dryRun: z.boolean(),
    name: vacationNameSchema,
  }),
  z.strictObject({
    action: z.literal("reminder"),
    expectedRevision: revisionSchema,
    dryRun: z.boolean(),
    /** Null turns it off. */
    reminderDays: reminderDaysSchema.nullable(),
  }),
  z.strictObject({
    action: z.literal("shorten"),
    expectedRevision: revisionSchema,
    dryRun: z.boolean(),
    endsOn: dateOnlySchema,
  }),
  z.strictObject({
    action: z.enum(["cancel", "pause", "unpause"]),
    expectedRevision: revisionSchema,
    dryRun: z.boolean(),
  }),
]);
export type VacationChangeInput = z.output<typeof vacationChangeSchema>;

export const participantsAddSchema = z.strictObject({
  expectedRevision: revisionSchema,
  dryRun: z.boolean(),
  people: peopleSchema,
});

export const participationChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.enum(["accept", "decline", "withdraw", "remove", "cancel_invitation"]),
    expectedRevision: revisionSchema,
    dryRun: z.boolean(),
  }),
  z
    .strictObject({
      action: z.enum(["change_dates", "propose_dates"]),
      expectedRevision: revisionSchema,
      dryRun: z.boolean(),
      startsOn: dateOnlySchema,
      endsOn: dateOnlySchema,
    })
    .refine(datesRefine, { message: "endBeforeStart", path: ["endsOn"] }),
]);
export type ParticipationChangeInput = z.output<typeof participationChangeSchema>;

export const proposalAnswerSchema = z.strictObject({
  action: z.enum(["accept", "decline", "withdraw"]),
  dryRun: z.boolean(),
});

export const decisionSchema = z
  .strictObject({
    sourceKind: z.enum(["vacation", "absence"]),
    sourceId: id,
    occurrenceId: id,
    expectedRevision: revisionSchema,
    decision: z.enum(["keep", "skip", "reassign", "reschedule"]),
    memberId: id.optional(),
    dueDate: dateOnlySchema.optional(),
    confirmAway: z.boolean().optional(),
  })
  .refine((input) => (input.decision === "reassign") === (input.memberId !== undefined), {
    message: "required",
    path: ["memberId"],
  })
  .refine((input) => (input.decision === "reschedule") === (input.dueDate !== undefined), {
    message: "required",
    path: ["dueDate"],
  })
  .refine((input) => !(input.sourceKind === "absence" && input.decision === "reschedule"), {
    message: "invalid",
    path: ["decision"],
  });
export type DecisionInput = z.output<typeof decisionSchema>;

export const absenceCreateSchema = z
  .strictObject({
    id,
    homeId: id,
    memberId: id,
    startsOn: dateOnlySchema,
    endsOn: dateOnlySchema,
    reason: absenceReasonSchema.optional(),
  })
  .refine(datesRefine, { message: "endBeforeStart", path: ["endsOn"] });

export const absenceChangeSchema = z.discriminatedUnion("action", [
  z
    .strictObject({
      action: z.literal("save"),
      expectedRevision: revisionSchema,
      /** Its Home and member, as read: they never change. */
      homeId: id,
      memberId: id,
      startsOn: dateOnlySchema,
      endsOn: dateOnlySchema,
      reason: absenceReasonSchema.optional(),
    })
    .refine(datesRefine, { message: "endBeforeStart", path: ["endsOn"] }),
  z.strictObject({ action: z.literal("remove"), expectedRevision: revisionSchema }),
]);
