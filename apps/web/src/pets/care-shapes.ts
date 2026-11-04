import { z } from "zod";

import {
  petCareCategories,
  petCareFrequencies,
  petCareStates,
  petCareStatuses,
} from "./care-schema";

/**
 * The shapes the pet-care reads answer with (S31 care part), checked on the server before anything
 * is shown. A concealed activity (medical details, no medical view) has no title, instructions or
 * notes: they are null, never empty strings.
 */

const member = z.uuid().nullable();

export const careOccurrenceSchema = z.object({
  id: z.uuid(),
  activityId: z.uuid(),
  scheduledOn: z.string(),
  dueOn: z.string(),
  time: z.string().nullable(),
  status: z.enum(petCareStatuses),
  detached: z.boolean(),
  revision: z.int(),
  members: z.array(member),
  mine: z.boolean(),
  completedAt: z.string().nullable(),
  completedBy: member,
  recordedByMe: z.boolean(),
  note: z.string().nullable(),
  skippedAt: z.string().nullable(),
  skippedBy: member,
  corrected: z.boolean(),
});
export type CareOccurrence = z.output<typeof careOccurrenceSchema>;

export const careScheduleShape = z.object({
  frequency: z.enum(petCareFrequencies),
  interval: z.int(),
  weekdays: z.array(z.int()).nullable(),
  startsOn: z.string(),
  endsOn: z.string().nullable(),
  time: z.string().nullable(),
  members: z.array(member),
});
export type CareSchedule = z.output<typeof careScheduleShape>;

export const careActivityShape = z.object({
  id: z.uuid(),
  petId: z.uuid(),
  title: z.string().nullable(),
  category: z.enum(petCareCategories),
  instructions: z.string().nullable(),
  medical: z.boolean(),
  concealed: z.boolean(),
  reminder: z.int().nullable(),
  state: z.enum(petCareStates),
  revision: z.int(),
  canEdit: z.boolean(),
  canManage: z.boolean(),
  schedule: careScheduleShape.nullable(),
  next: careOccurrenceSchema.nullable(),
  overdue: z.int(),
});
export type CareActivity = z.output<typeof careActivityShape>;

export const petCareShape = z.object({
  petId: z.uuid(),
  today: z.string(),
  canManage: z.boolean(),
  canManageMedical: z.boolean(),
  activities: z.array(careActivityShape),
});
export type PetCare = z.output<typeof petCareShape>;

export const careActivityDetailShape = careActivityShape.extend({
  homeId: z.uuid(),
  timeZone: z.string(),
  today: z.string(),
  open: z.array(careOccurrenceSchema),
  recent: z.array(careOccurrenceSchema),
});
export type CareActivityDetail = z.output<typeof careActivityDetailShape>;

export const homeCareRowSchema = careOccurrenceSchema.extend({
  petId: z.uuid(),
  petName: z.string(),
  activity: z.object({
    title: z.string().nullable(),
    category: z.enum(petCareCategories),
    medical: z.boolean(),
    concealed: z.boolean(),
  }),
});
export type HomeCareRow = z.output<typeof homeCareRowSchema>;

export const homeCareShape = z.object({
  today: z.string(),
  rows: z.array(homeCareRowSchema),
  hasMore: z.boolean(),
});
export type HomeCare = z.output<typeof homeCareShape>;
