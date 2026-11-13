import { z } from "zod";

import { nameProblem, normalizeName } from "@/names/visible-name";

import { displayPreferencesSchema, lockMessageSchema } from "./layout";

/**
 * Client-safe rules and request schemas for Household Display pairing (S43, brief defaults). The
 * server parses every body with these again; the database re-checks the name and only ever sees a
 * SHA-256 of a pairing code.
 */

/** Letters and digits that cannot be mistaken for one another (no 0/O, 1/I/L). */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const DISPLAY_NAME_MAX_LENGTH = 40;

/**
 * A code as someone typed it: case, spaces and dashes do not matter. `null` when it cannot be a
 * pairing code at all.
 */
export function normalizePairingCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const character of code) {
    if (!PAIRING_CODE_ALPHABET.includes(character)) return null;
  }
  return code;
}

/** `ABCDEFGH` → `ABCD-EFGH`, the way the tablet shows it. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export const pairingCodeSchema = z
  .string()
  .max(40)
  .transform((value, context) => {
    const code = normalizePairingCode(value);
    if (!code) {
      context.addIssue({ code: "custom", message: "codeInvalid" });
      return z.NEVER;
    }
    return code;
  });

export const displayNameSchema = z
  .string()
  .max(1000)
  .transform((value, context) => {
    const name = normalizeName(value);
    if (name === "" || nameProblem(name, DISPLAY_NAME_MAX_LENGTH)) {
      context.addIssue({ code: "custom", message: "nameInvalid" });
      return z.NEVER;
    }
    return name;
  });

// Request bodies --------------------------------------------------------------------------------

/** The tablet: resume its code (or get one), or throw it away for a new one. */
export const pairingRequestSchema = z.strictObject({ renew: z.boolean() });
export type PairingRequestInput = z.input<typeof pairingRequestSchema>;

export const checkCodeSchema = z.strictObject({ code: pairingCodeSchema });
export type CheckCodeInput = z.input<typeof checkCodeSchema>;

export const approveDisplaySchema = z.strictObject({
  requestId: z.uuid(),
  code: pairingCodeSchema,
  name: displayNameSchema,
});
export type ApproveDisplayInput = z.input<typeof approveDisplaySchema>;

export const renameDisplaySchema = z.strictObject({ name: displayNameSchema });
export type RenameDisplayInput = z.input<typeof renameDisplaySchema>;

/**
 * A display's configuration save (S44): the layout is checked with `checkDisplayLayout` (null:
 * restore the default layout), against the revision the manager edited.
 */
export const saveDisplayConfigSchema = z.strictObject({
  expectedRevision: z.int().min(1).max(2_147_483_647),
  layout: z.unknown(),
  preferences: displayPreferencesSchema,
});
export type SaveDisplayConfigInput = z.input<typeof saveDisplayConfigSchema>;

/** Locks or unlocks a display from a manager's own session, with the lock screen's message. */
export const displayLockStateSchema = z.strictObject({
  locked: z.boolean(),
  message: lockMessageSchema,
});
export type DisplayLockStateInput = z.input<typeof displayLockStateSchema>;
