import {
  childAgeBands,
  childCapabilities,
  childPresets,
  type ChildOverrides,
} from "@madeora/domain/permissions";
import { z } from "zod";

import { accentColorSchema } from "@/accent/accent";
import { optionalNameSchema } from "@/preferences/schema";

/**
 * Client-safe request schemas for child profiles and guardians (S41). The server parses every body
 * with these again and the database functions re-check everything under the Home lock
 * (supabase/migrations/20261129090000_child_profiles.sql).
 */

/** A required visible name (the S11 rule); empty is refused. */
const requiredNameSchema = optionalNameSchema.refine((name) => name !== null, {
  message: "childNameRequired",
});

export const createChildSchema = z.strictObject({
  name: requiredNameSchema,
  primaryGuardianMembershipId: z.uuid(),
  /** Optional, only to suggest a preset; never used for access (Ward, 2026-11-11). */
  ageBand: z.enum(childAgeBands).nullable(),
  accentColor: accentColorSchema,
  /** Generated once per form, so a retry returns the same child. */
  requestId: z.uuid(),
});
export type CreateChildInput = z.input<typeof createChildSchema>;

const overridesSchema = z
  .partialRecord(z.enum(childCapabilities), z.boolean())
  .transform((value): ChildOverrides => value);

export const childAccessSchema = z.strictObject({
  preset: z.enum(childPresets),
  overrides: overridesSchema,
  /** Set after the guardian saw the before/after preview of a change that widens access. */
  confirmExpansion: z.boolean(),
  /** The settings version the guardian edited; a change made meanwhile is refused. */
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
});
export type ChildAccessInput = z.input<typeof childAccessSchema>;

export const childPresentationSchema = z.strictObject({
  /** Empty clears the Home name, so the name given at creation shows. */
  displayName: optionalNameSchema,
  accentColor: accentColorSchema,
});
export type ChildPresentationInput = z.input<typeof childPresentationSchema>;

export const guardianRoles = ["primary", "secondary"] as const;

export const assignGuardianSchema = z.strictObject({
  role: z.enum(guardianRoles),
  guardianMembershipId: z.uuid(),
});
export type AssignGuardianInput = z.infer<typeof assignGuardianSchema>;

export const emptyBodySchema = z.strictObject({});

export const offerActions = ["accept", "decline", "cancel"] as const;
export const offerActionSchema = z.strictObject({ action: z.enum(offerActions) });
export type OfferActionInput = z.infer<typeof offerActionSchema>;

export const linkCodeActionSchema = z.strictObject({ action: z.enum(["issue", "cancel"]) });
export type LinkCodeActionInput = z.infer<typeof linkCodeActionSchema>;

/** A link code as typed: XXXX-XXXX-XXXX-XXXX in any case, spaces and dashes optional. */
export const redeemLinkSchema = z.strictObject({
  code: z
    .string()
    .max(64)
    .refine((value) => /^[0-9A-Za-z]{16}$/.test(value.replace(/[\s-]/g, "")), {
      message: "linkCodeInvalid",
    }),
  accentColor: accentColorSchema,
});
export type RedeemLinkInput = z.input<typeof redeemLinkSchema>;
