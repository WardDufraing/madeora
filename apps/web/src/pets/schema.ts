import { z } from "zod";

import { petMedicalChoices } from "@madeora/domain/permissions";

import { attachmentNameSchema } from "@/tasks/attachment-policy";
import { plainTextSchema } from "@/tasks/schema";

/**
 * The pets contract (S31, versioned for later mobile clients). Client-safe. Every limit and list
 * matches the database (`private.pet_limit`, `private.pet_species`, `private.pet_event_types` and the
 * checks in supabase/migrations/*_pets.sql), which checks everything again.
 */

export const PET_LIMITS = {
  pets: 50,
  entries: 1000,
  attachments: 10,
  name: 80,
  short: 120,
  location: 200,
  address: 300,
  long: 2000,
  identifier: 64,
  identificationNotes: 500,
  phone: 40,
  email: 254,
  maxAgeYears: 60,
  maxWeight: 2000,
  /** Medical entries at most this many days ahead (two years). */
  entryDaysAhead: 730,
  /** Follow-ups at most this many days ahead (five years). */
  followUpDaysAhead: 1826,
} as const;

export const PET_FILE_MAX_BYTES = 10 * 1024 * 1024;

export const petSpecies = [
  "dog",
  "cat",
  "rabbit",
  "guinea_pig",
  "hamster",
  "bird",
  "fish",
  "reptile",
  "horse",
  "other",
] as const;
export type PetSpecies = (typeof petSpecies)[number];

export const petSexes = ["female", "male"] as const;
export const petWeightUnits = ["kg", "g", "lb"] as const;
export type PetWeightUnit = (typeof petWeightUnits)[number];

export const petEventTypes = [
  "vet_visit",
  "vaccination",
  "treatment",
  "test",
  "surgery",
  "other",
] as const;
export type PetEventType = (typeof petEventTypes)[number];

/** Basic-profile fields that may be marked explicitly Unknown. */
export const petUnknownFields = [
  "species",
  "breed",
  "birth",
  "sex",
  "neutered",
  "weight",
  "diet",
] as const;
export type PetUnknownField = (typeof petUnknownFields)[number];

/** Sensitive fields that may be marked Unknown, and those that may be recorded as None. */
export const medicalUnknownFields = [
  "allergies",
  "medications",
  "microchip",
  "registration",
] as const;
export type MedicalUnknownField = (typeof medicalUnknownFields)[number];
export const medicalNoneFields = ["allergies", "medications"] as const;
export type MedicalNoneField = (typeof medicalNoneFields)[number];

/** A medical attachment: images and PDF only (invoices, certificates). */
export const petAttachmentTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;
export type PetAttachmentType = (typeof petAttachmentTypes)[number];
export const petPhotoTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type PetPhotoType = (typeof petPhotoTypes)[number];

export function isPetAttachmentType(value: unknown): value is PetAttachmentType {
  return typeof value === "string" && (petAttachmentTypes as readonly string[]).includes(value);
}

export function isPetPhotoType(value: unknown): value is PetPhotoType {
  return typeof value === "string" && (petPhotoTypes as readonly string[]).includes(value);
}

const id = z.uuid();
const revision = z.int().min(1);

/** A calendar date, YYYY-MM-DD, that exists. */
export const petDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "invalid")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, "invalid");

/** One line of text, trimmed; empty means not entered. */
function line(max: number) {
  return z
    .string()
    .transform((value) => value.trim())
    .transform((value) => (value === "" ? null : value))
    .pipe(
      plainTextSchema(max)
        .refine((value) => !/[\t\r\n]/u.test(value), "invalidCharacters")
        .nullable(),
    )
    .nullable()
    .default(null);
}

/** Free text over several lines; empty (or only whitespace) means not entered. */
function text(max: number) {
  return z
    .string()
    .transform((value) => (value.trim() === "" ? null : value))
    .pipe(plainTextSchema(max).nullable())
    .nullable()
    .default(null);
}

function fields<const T extends readonly [string, ...string[]]>(values: T) {
  return z
    .array(z.enum(values))
    .refine((list) => new Set(list).size === list.length, "invalid")
    .default([]);
}

export const petNameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    plainTextSchema(PET_LIMITS.name).refine(
      (value) => !/[\t\r\n]/u.test(value),
      "invalidCharacters",
    ),
  );

/** `POST /api/v1/pets`: a pet starts with only its name. */
export const createPetSchema = z.strictObject({
  id,
  homeId: id,
  name: petNameSchema,
});

const phonePattern = /^[0-9+() ./-]+$/u;
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

/**
 * The basic profile as the API takes it: every field, a missing one is not entered. Values the
 * database refuses are refused here first, each at its field.
 */
export const petProfileSchema = z
  .strictObject({
    name: petNameSchema,
    species: z.enum(petSpecies).nullable().default(null),
    speciesLabel: line(PET_LIMITS.short),
    breed: line(PET_LIMITS.short),
    birthDate: petDateSchema.nullable().default(null),
    ageYears: z.int().min(0).max(PET_LIMITS.maxAgeYears).nullable().default(null),
    ageMonths: z.int().min(0).max(11).nullable().default(null),
    ageRecordedOn: petDateSchema.nullable().default(null),
    sex: z.enum(petSexes).nullable().default(null),
    neutered: z.boolean().nullable().default(null),
    weight: z
      .number()
      .gt(0)
      .max(PET_LIMITS.maxWeight)
      .refine((value) => Math.round(value * 1000) === value * 1000, "invalid")
      .nullable()
      .default(null),
    weightUnit: z.enum(petWeightUnits).nullable().default(null),
    weightRecordedOn: petDateSchema.nullable().default(null),
    vetName: line(PET_LIMITS.short),
    vetClinic: line(PET_LIMITS.short),
    vetPhone: line(PET_LIMITS.phone).refine(
      (value) => value === null || (phonePattern.test(value) && /\d/u.test(value)),
      "invalid",
    ),
    vetEmail: line(PET_LIMITS.email).refine(
      (value) => value === null || emailPattern.test(value),
      "invalid",
    ),
    vetAddress: text(PET_LIMITS.address),
    diet: text(PET_LIMITS.long),
    careInstructions: text(PET_LIMITS.long),
    notes: text(PET_LIMITS.long),
    unknown: fields(petUnknownFields),
  })
  .superRefine((profile, context) => {
    const issue = (path: string, message = "invalid") => {
      context.addIssue({ code: "custom", path: [path], message });
    };
    if (profile.speciesLabel !== null && profile.species !== "other") issue("speciesLabel");
    const hasAge = profile.ageYears !== null || profile.ageMonths !== null;
    if (profile.birthDate !== null && hasAge) issue("ageYears", "birthOrAge");
    if (hasAge && (profile.ageYears ?? 0) === 0 && (profile.ageMonths ?? 0) === 0) {
      issue("ageYears");
    }
    if (!hasAge && profile.ageRecordedOn !== null) issue("ageRecordedOn");
    if ((profile.weight === null) !== (profile.weightUnit === null)) issue("weight", "weightUnit");
    if (profile.weight === null && profile.weightRecordedOn !== null) issue("weightRecordedOn");
    const has: { readonly [F in PetUnknownField]: boolean } = {
      species: profile.species !== null,
      breed: profile.breed !== null,
      birth: profile.birthDate !== null || hasAge,
      sex: profile.sex !== null,
      neutered: profile.neutered !== null,
      weight: profile.weight !== null,
      diet: profile.diet !== null,
    };
    for (const field of profile.unknown) if (has[field]) issue("unknown");
  });
export type PetProfileInput = z.output<typeof petProfileSchema>;

/** `PATCH /api/v1/pets/:id`. */
export const updatePetSchema = z.strictObject({ revision, profile: petProfileSchema });

/** `DELETE /api/v1/pets/:id` and `DELETE /api/v1/pets/:id/photo`. */
export const revisionSchema = z.strictObject({ revision });

/** The sensitive details as the API takes them. */
export const medicalDetailsSchema = z
  .strictObject({
    allergies: text(PET_LIMITS.long),
    medications: text(PET_LIMITS.long),
    microchip: line(PET_LIMITS.identifier),
    registration: line(PET_LIMITS.identifier),
    identificationNotes: text(PET_LIMITS.identificationNotes),
    medicalNotes: text(PET_LIMITS.long),
    unknown: fields(medicalUnknownFields),
    none: fields(medicalNoneFields),
  })
  .superRefine((details, context) => {
    const issue = (path: string) => {
      context.addIssue({ code: "custom", path: [path], message: "invalid" });
    };
    for (const field of details.none) {
      if (details.unknown.includes(field) || details[field] !== null) issue(field);
    }
    for (const field of details.unknown) if (details[field] !== null) issue(field);
  });
export type MedicalDetailsInput = z.output<typeof medicalDetailsSchema>;

/** `PUT /api/v1/pets/:id/medical`: 0 is the revision of details never saved. */
export const putMedicalSchema = z.strictObject({
  revision: z.int().min(0),
  details: medicalDetailsSchema,
});

/** A medical entry: a type and a date; the rest optional. */
export const medicalEntrySchema = z
  .strictObject({
    type: z.enum(petEventTypes),
    date: petDateSchema,
    title: line(PET_LIMITS.short),
    veterinarian: line(PET_LIMITS.short),
    location: line(PET_LIMITS.location),
    treatment: text(PET_LIMITS.long),
    notes: text(PET_LIMITS.long),
    followUpDate: petDateSchema.nullable().default(null),
  })
  .superRefine((entry, context) => {
    if (entry.followUpDate !== null && entry.followUpDate < entry.date) {
      context.addIssue({ code: "custom", path: ["followUpDate"], message: "beforeEvent" });
    }
  });
export type MedicalEntryInput = z.output<typeof medicalEntrySchema>;

/** `POST /api/v1/pets/:id/medical-entries`. */
export const createEntrySchema = z.strictObject({ id, entry: medicalEntrySchema });
/** `PATCH /api/v1/pet-medical-entries/:id`. */
export const updateEntrySchema = z.strictObject({ revision, entry: medicalEntrySchema });

/** `POST /api/v1/pets/:id/photo`: opens a photo upload. */
export const photoIntentSchema = z.strictObject({
  contentType: z.enum(petPhotoTypes),
  size: z.number().int().min(1).max(PET_FILE_MAX_BYTES),
  requestId: id,
});

/** `POST /api/v1/pet-medical-entries/:id/attachments`: opens an attachment upload. */
export const attachmentIntentSchema = z.strictObject({
  contentType: z.enum(petAttachmentTypes),
  size: z.number().int().min(1).max(PET_FILE_MAX_BYTES),
  name: attachmentNameSchema,
  requestId: id,
});

/** `PUT /api/v1/homes/:homeId/pet-medical-access`. */
export const medicalAccessSchema = z.strictObject({
  membershipId: id,
  level: z.enum(petMedicalChoices),
});

/** `GET /api/v1/pets?homeId=`. */
export const listQuerySchema = z.strictObject({ homeId: id });
