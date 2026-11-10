import { z } from "zod";

import { EXPORT_CATEGORIES, HOME_EXPORT_CATEGORIES, REVIEW_STEPS } from "./catalogue";

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
