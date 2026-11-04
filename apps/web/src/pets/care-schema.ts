import { z } from "zod";

import { plainTextSchema } from "@/tasks/schema";

import { petDateSchema } from "./schema";

/**
 * The pet-care contract (S31 care part, versioned for later mobile clients). Client-safe. Every limit
 * and list matches the database (`private.pet_care_limit` and the checks in
 * supabase/migrations/*_pet_care.sql), which checks everything again.
 */

export const PET_CARE_LIMITS = {
  activities: 100,
  title: 120,
  instructions: 2000,
  note: 500,
  members: 10,
  /** Occurrences exist this many days ahead. */
  horizon: 7,
  /** Overdue care older than this many days leaves the widget. */
  window: 7,
  maxInterval: 99,
} as const;

export const petCareCategories = [
  "feeding",
  "medication",
  "grooming",
  "vet_appointment",
  "other",
] as const;
export type PetCareCategory = (typeof petCareCategories)[number];

export const petCareFrequencies = ["once", "daily", "weekly", "monthly", "yearly"] as const;
export type PetCareFrequency = (typeof petCareFrequencies)[number];

/** Minutes before the occurrence's time (08:00 Home time without one); null: no reminder. */
export const petCareReminders = [0, 15, 60, 1440] as const;
export type PetCareReminder = (typeof petCareReminders)[number];

export const petCareStates = ["active", "paused", "ended"] as const;
export type PetCareState = (typeof petCareStates)[number];

export const petCareStatuses = [
  "upcoming",
  "due",
  "overdue",
  "completed",
  "skipped",
  "paused",
] as const;
export type PetCareStatus = (typeof petCareStatuses)[number];

export const petCareRanges = [1, 3, 7] as const;
export const petCareWho = ["all", "me", "unassigned"] as const;
export type PetCareWho = (typeof petCareWho)[number];
export const petCareCounts = [5, 10, 15] as const;

const id = z.uuid();
const revision = z.int().min(1);

/** A time of day, HH:MM. */
export const petTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "invalid");

/** An activity's own fields. Medication always has medical details. */
export const careActivitySchema = z
  .strictObject({
    title: z
      .string()
      .transform((value) => value.trim())
      .pipe(
        plainTextSchema(PET_CARE_LIMITS.title).refine(
          (value) => !/[\t\r\n]/u.test(value),
          "invalidCharacters",
        ),
      ),
    category: z.enum(petCareCategories).default("other"),
    instructions: z
      .string()
      .transform((value) => (value.trim() === "" ? null : value))
      .pipe(plainTextSchema(PET_CARE_LIMITS.instructions).nullable())
      .nullable()
      .default(null),
    medical: z.boolean().default(false),
    reminder: z
      .union([z.literal(0), z.literal(15), z.literal(60), z.literal(1440)])
      .nullable()
      .default(null),
  })
  .transform((activity) => ({
    ...activity,
    medical: activity.medical || activity.category === "medication",
  }));
export type CareActivityInput = z.output<typeof careActivitySchema>;

/** A schedule: once on a date, or the S19 recurrence from a start; optional time and members. */
export const careScheduleSchema = z
  .strictObject({
    frequency: z.enum(petCareFrequencies),
    interval: z.int().min(1).max(PET_CARE_LIMITS.maxInterval).default(1),
    weekdays: z
      .array(z.int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((list) => new Set(list).size === list.length, "invalid")
      .nullable()
      .default(null),
    startsOn: petDateSchema,
    endsOn: petDateSchema.nullable().default(null),
    time: petTimeSchema.nullable().default(null),
    members: z
      .array(id)
      .max(PET_CARE_LIMITS.members)
      .refine((list) => new Set(list).size === list.length, "invalid")
      .default([]),
  })
  .superRefine((schedule, context) => {
    if ((schedule.frequency === "weekly") !== (schedule.weekdays !== null)) {
      context.addIssue({ code: "custom", path: ["weekdays"], message: "required" });
    }
    if (schedule.frequency === "once" && (schedule.interval !== 1 || schedule.endsOn !== null)) {
      context.addIssue({ code: "custom", path: ["endsOn"], message: "invalid" });
    }
    if (schedule.endsOn !== null && schedule.endsOn < schedule.startsOn) {
      context.addIssue({ code: "custom", path: ["endsOn"], message: "beforeStart" });
    }
  });
export type CareScheduleInput = z.output<typeof careScheduleSchema>;

/** `POST /api/v1/pets/:id/care`. */
export const createCareSchema = z.strictObject({
  id,
  activity: careActivitySchema,
  schedule: careScheduleSchema,
});

/** `PATCH /api/v1/pet-care/:id`: the activity; with a schedule, from a date on. */
export const updateCareSchema = z
  .strictObject({
    revision,
    activity: careActivitySchema,
    schedule: careScheduleSchema.nullable().default(null),
    from: petDateSchema.nullable().default(null),
  })
  .refine((body) => (body.schedule === null) === (body.from === null), {
    path: ["from"],
    message: "required",
  });

/** `POST /api/v1/pet-care/:id/state`. */
export const careStateSchema = z.strictObject({ revision, state: z.enum(petCareStates) });

const note = z
  .string()
  .transform((value) => (value.trim() === "" ? null : value.trim()))
  .pipe(plainTextSchema(PET_CARE_LIMITS.note).nullable())
  .nullable()
  .default(null);

/** `POST /api/v1/pet-care-occurrences/:id`: one action on one occurrence. */
export const occurrenceActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("complete"),
    revision,
    completedAt: z.iso.datetime().nullable().default(null),
    note,
  }),
  z.strictObject({ action: z.literal("skip"), revision }),
  z.strictObject({ action: z.literal("reopen"), revision }),
  z.strictObject({
    action: z.literal("correct"),
    revision,
    completedAt: z.iso.datetime(),
    note,
  }),
  z.strictObject({
    action: z.literal("update"),
    revision,
    dueOn: petDateSchema,
    time: petTimeSchema.nullable(),
    members: z
      .array(id)
      .max(PET_CARE_LIMITS.members)
      .refine((list) => new Set(list).size === list.length, "invalid"),
  }),
]);
export type OccurrenceAction = z.input<typeof occurrenceActionSchema>;

/** `GET /api/v1/pet-care?homeId=&petId=&days=&who=&count=`: the widget's rows. */
export const careQuerySchema = z.strictObject({
  homeId: id,
  petId: id.optional(),
  days: z.coerce.number().pipe(z.union([z.literal(1), z.literal(3), z.literal(7)])),
  who: z.enum(petCareWho),
  count: z.coerce.number().pipe(z.union([z.literal(5), z.literal(10), z.literal(15)])),
});
