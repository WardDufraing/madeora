import { z } from "zod";

import { normalizeTimeZone } from "@/preferences/timezone";

/** Bodies of the activity endpoints (S38). Client-safe; the server validates again. */
export const signInResponseSchema = z.strictObject({
  response: z.enum(["confirmed", "reported"]),
});
export type SignInResponseInput = z.infer<typeof signInResponseSchema>;

export const securityAlertsSchema = z.strictObject({
  newDevice: z.boolean(),
  everySignIn: z.boolean(),
});
export type SecurityAlertsInput = z.infer<typeof securityAlertsSchema>;

export const securityReportRequestSchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    timeZone: z
      .string()
      .max(64)
      .refine((value) => normalizeTimeZone(value) !== null, { message: "timeZone" }),
  })
  .refine((value) => value.from <= value.to, { path: ["to"], message: "range" });
export type SecurityReportRequestInput = z.infer<typeof securityReportRequestSchema>;

export const securityReportDownloadSchema = z.strictObject({
  format: z.enum(["csv", "json"]),
});
export type SecurityReportFormat = z.infer<typeof securityReportDownloadSchema>["format"];

/** The account lifecycle endpoints take an empty body (S38). */
export const emptyBodySchema = z.strictObject({});

/**
 * S40: the words typed to confirm account deletion, in either interface language. The database
 * asks for its own fresh re-authentication; this only proves the person meant it.
 */
export const ACCOUNT_DELETION_PHRASES = ["DELETE", "VERWIJDER"] as const;
export const accountDeletionSchema = z.strictObject({
  confirmation: z
    .string()
    .max(20)
    .transform((value) => value.trim())
    .refine((value) => (ACCOUNT_DELETION_PHRASES as readonly string[]).includes(value)),
});

/** S40: the Home's name as typed by its Owner to confirm closing it (the database compares it). */
export const closeHomeSchema = z.strictObject({
  name: z.string().min(1).max(200),
});
