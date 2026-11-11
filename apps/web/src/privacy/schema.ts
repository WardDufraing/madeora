import { z } from "zod";

import {
  DELETION_CATEGORIES,
  EXPORT_CATEGORIES,
  HOME_EXPORT_CATEGORIES,
  REVIEW_STEPS,
} from "./catalogue";

/**
 * Bodies of the privacy endpoints (S39). Client-safe; the server validates again and the database
 * decides what each category may contain. `homeIds` are exactly the Homes chosen for Home-specific
 * settings and the person's own contributions (empty: none).
 */
export const exportRequestSchema = z
  .strictObject({
    allData: z.boolean(),
    categories: z.array(z.enum(EXPORT_CATEGORIES)).max(EXPORT_CATEGORIES.length),
    homeIds: z.array(z.uuid()).max(50),
  })
  .refine((value) => value.allData || value.categories.length > 0, {
    path: ["categories"],
    message: "empty",
  })
  .refine(
    (value) =>
      value.allData || !value.categories.includes("home_contributions") || value.homeIds.length > 0,
    { path: ["homeIds"], message: "homes" },
  );
export type ExportRequestInput = z.infer<typeof exportRequestSchema>;

/** A Home export (S39 part 2): every Home category, or the chosen ones. */
export const homeExportRequestSchema = z
  .strictObject({
    allData: z.boolean(),
    categories: z.array(z.enum(HOME_EXPORT_CATEGORIES)).max(HOME_EXPORT_CATEGORIES.length),
  })
  .refine((value) => value.allData || value.categories.length > 0, {
    path: ["categories"],
    message: "empty",
  });
export type HomeExportRequestInput = z.infer<typeof homeExportRequestSchema>;

/** The Owner grants or revokes exportHomeData for one membership. */
export const homeExportAccessSchema = z.strictObject({
  membershipId: z.uuid(),
  granted: z.boolean(),
});
export type HomeExportAccessInput = z.infer<typeof homeExportAccessSchema>;

export const reviewActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("start") }),
  z.strictObject({ action: z.literal("step"), step: z.enum(REVIEW_STEPS) }),
  z.strictObject({ action: z.literal("finish") }),
  z.strictObject({ action: z.literal("dismiss") }),
]);
export type ReviewActionInput = z.infer<typeof reviewActionSchema>;

/** The words that confirm a category deletion (either language is accepted everywhere). */
export const DATA_DELETION_PHRASES = ["DELETE", "VERWIJDER"] as const;

/**
 * Deleting personal data by category (S40 part 2): the client's request id (a repeat returns the
 * first result), at least one category, and the typed confirmation word.
 */
export const personalDeletionSchema = z.strictObject({
  requestId: z.uuid(),
  categories: z
    .array(z.enum(DELETION_CATEGORIES))
    .min(1)
    .max(DELETION_CATEGORIES.length)
    .refine((value) => new Set(value).size === value.length, { message: "duplicate" }),
  confirmation: z.enum(DATA_DELETION_PHRASES),
});
export type PersonalDeletionInput = z.infer<typeof personalDeletionSchema>;
