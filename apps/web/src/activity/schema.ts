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
