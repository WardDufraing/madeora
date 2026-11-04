import { z } from "zod";

import { petMedicalLevels } from "@madeora/domain/permissions";

import {
  medicalNoneFields,
  medicalUnknownFields,
  petEventTypes,
  petSexes,
  petSpecies,
  petUnknownFields,
  petWeightUnits,
} from "./schema";

/**
 * The shapes the pets reads answer with (S31), checked on the server before anything is shown, so a
 * database change cannot reach the interface unnoticed. Client-safe.
 */

const date = z.string();
const nullableText = z.string().nullable();
const access = z.enum(["manage", "view"]);
const medicalLevel = z.enum(petMedicalLevels).nullable();
// JSON numbers from `numeric` columns.
const decimal = z.union([z.number(), z.string().transform(Number)]);

export const petSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  species: z.enum(petSpecies).nullable(),
  speciesLabel: nullableText,
  birthDate: date.nullable(),
  ageYears: z.int().nullable(),
  ageMonths: z.int().nullable(),
  ageRecordedOn: date.nullable(),
  photoFileId: z.uuid().nullable(),
});
export type PetSummary = z.output<typeof petSummarySchema>;

export const petListSchema = z.object({
  access,
  medicalAccess: medicalLevel,
  limit: z.int(),
  pets: z.array(petSummarySchema),
});
export type PetList = z.output<typeof petListSchema>;

export const petDetailSchema = petSummarySchema.extend({
  homeId: z.uuid(),
  breed: nullableText,
  sex: z.enum(petSexes).nullable(),
  neutered: z.boolean().nullable(),
  weight: decimal.nullable(),
  weightUnit: z.enum(petWeightUnits).nullable(),
  weightRecordedOn: date.nullable(),
  vetName: nullableText,
  vetClinic: nullableText,
  vetPhone: nullableText,
  vetEmail: nullableText,
  vetAddress: nullableText,
  diet: nullableText,
  careInstructions: nullableText,
  notes: nullableText,
  unknown: z.array(z.enum(petUnknownFields)),
  revision: z.int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  access,
  medicalAccess: medicalLevel,
  today: date,
});
export type PetDetail = z.output<typeof petDetailSchema>;

export const medicalAttachmentSchema = z.object({
  id: z.uuid(),
  fileId: z.uuid(),
  name: z.string(),
  contentType: z.string().nullable(),
  size: z.number().nullable(),
  addedAt: z.string(),
});
export type MedicalAttachment = z.output<typeof medicalAttachmentSchema>;

export const medicalEntrySchema = z.object({
  id: z.uuid(),
  petId: z.uuid(),
  type: z.enum(petEventTypes),
  date,
  title: nullableText,
  veterinarian: nullableText,
  location: nullableText,
  treatment: nullableText,
  notes: nullableText,
  followUpDate: date.nullable(),
  revision: z.int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  attachments: z.array(medicalAttachmentSchema),
});
export type MedicalEntry = z.output<typeof medicalEntrySchema>;

export const medicalEntryDetailSchema = medicalEntrySchema.extend({
  petName: z.string(),
  homeId: z.uuid(),
  level: z.enum(petMedicalLevels),
  today: date,
});
export type MedicalEntryDetail = z.output<typeof medicalEntryDetailSchema>;

export const petMedicalSchema = z.object({
  petId: z.uuid(),
  level: z.enum(petMedicalLevels),
  today: date,
  details: z.object({
    allergies: nullableText,
    medications: nullableText,
    microchip: nullableText,
    registration: nullableText,
    identificationNotes: nullableText,
    medicalNotes: nullableText,
    unknown: z.array(z.enum(medicalUnknownFields)),
    none: z.array(z.enum(medicalNoneFields)),
    revision: z.int(),
    updatedAt: z.string().nullable(),
  }),
  entries: z.array(medicalEntrySchema),
});
export type PetMedical = z.output<typeof petMedicalSchema>;
export type PetMedicalDetails = PetMedical["details"];

export const medicalAccessListSchema = z.object({
  canGrant: z.boolean(),
  members: z.array(
    z.object({
      membershipId: z.uuid(),
      isSelf: z.boolean(),
      role: z.enum(["owner", "administrator", "member"]),
      level: z.enum(["none", "view", "manage"]),
      canChange: z.boolean(),
    }),
  ),
});
export type MedicalAccessList = z.output<typeof medicalAccessListSchema>;

/** A mutation's answer: its outcome and, where there is one, the new revision or trash entry. */
export const petResultSchema = z.object({
  outcome: z.string(),
  id: z.uuid().optional(),
  revision: z.int().optional(),
  entryId: z.uuid().optional(),
  attachmentId: z.uuid().optional(),
});
export type PetResult = z.output<typeof petResultSchema>;
