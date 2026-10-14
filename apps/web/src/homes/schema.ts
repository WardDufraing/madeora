import { z } from "zod";

import { nameProblem, normalizeName } from "@/names/visible-name";
import { normalizeTimeZone } from "@/preferences/timezone";

/**
 * Home input rules (S09), shared by the forms and the API routes. The database checks the same
 * rules (supabase/migrations/20261016090000_homes.sql); change both together. Client-safe.
 */

export const HOME_NAME_MAX_LENGTH = 50;

/** Error message keys, translated in the `Homes` namespace. */
export type HomeFieldError = "nameRequired" | "nameTooLong" | "nameInvalid" | "timeZoneInvalid";

/** A Home name as typed: NFC-normalized and trimmed, then checked against the name policy. */
export const homeNameSchema = z
  .string({ error: "nameRequired" satisfies HomeFieldError })
  .max(1000, { error: "nameTooLong" satisfies HomeFieldError })
  .transform((value, context) => {
    const name = normalizeName(value);
    if (name === "") {
      context.addIssue({ code: "custom", message: "nameRequired" satisfies HomeFieldError });
      return z.NEVER;
    }
    const problem = nameProblem(name, HOME_NAME_MAX_LENGTH);
    if (problem) {
      context.addIssue({
        code: "custom",
        message: (problem === "tooLong" ? "nameTooLong" : "nameInvalid") satisfies HomeFieldError,
      });
      return z.NEVER;
    }
    return name;
  });

/** The Home's scheduling timezone: an IANA zone this runtime knows, with its usual capitals. */
export const homeTimeZoneSchema = z
  .string({ error: "timeZoneInvalid" satisfies HomeFieldError })
  .max(64, { error: "timeZoneInvalid" satisfies HomeFieldError })
  .transform((value, context) => {
    const zone = normalizeTimeZone(value);
    if (zone === null) {
      context.addIssue({ code: "custom", message: "timeZoneInvalid" satisfies HomeFieldError });
      return z.NEVER;
    }
    return zone;
  });

export const homeIdSchema = z.uuid();

/** `POST /api/v1/homes`. `requestId` is generated once per form, so a retry never makes two. */
export const createHomeSchema = z.strictObject({
  name: homeNameSchema,
  timeZone: homeTimeZoneSchema,
  requestId: z.uuid(),
});
export type CreateHomeInput = z.input<typeof createHomeSchema>;

/** `PATCH /api/v1/homes/{homeId}`: some of the Home's settings. At least one field. */
export const homeSettingsPatchSchema = z
  .strictObject({
    name: homeNameSchema.optional(),
    timeZone: homeTimeZoneSchema.optional(),
  })
  .refine((patch) => patch.name !== undefined || patch.timeZone !== undefined, {
    error: "empty",
  });
export type HomeSettingsPatchInput = z.input<typeof homeSettingsPatchSchema>;
export type HomeSettingsPatch = z.output<typeof homeSettingsPatchSchema>;
