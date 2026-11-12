import { z } from "zod";

import { nameProblem, normalizeName } from "@/names/visible-name";

/**
 * Client-safe rules and request schemas for child sign-in (S42, brief defaults). The server parses
 * every body with these again; the database re-checks the username format and only ever sees
 * hashes of passwords and PINs.
 */

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,22}[a-z0-9]$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
export const DEVICE_LABEL_MAX_LENGTH = 60;

/** 3 to 24 characters: a–z, 0–9, '.', '_', '-'; starts and ends with a letter or digit. */
export const usernameSchema = z
  .string()
  .max(100)
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => USERNAME_PATTERN.test(value), { error: "usernameInvalid" });

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { error: "passwordTooShort" })
  .max(PASSWORD_MAX_LENGTH, { error: "passwordTooLong" });

export type PinProblem = "pinFormat" | "pinTooSimple";

/**
 * Why a PIN is refused: not 4–8 digits, or too easy to guess (one digit repeated, or a straight
 * run up or down such as 1234 or 9876).
 */
export function pinProblem(pin: string): PinProblem | null {
  if (!/^\d+$/.test(pin) || pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
    return "pinFormat";
  }
  // Already checked to be ASCII digits only.
  const digits = Array.from(pin, Number);
  const steps = digits.slice(1).map((digit, index) => digit - (digits[index] ?? 0));
  if (steps.every((step) => step === 0)) return "pinTooSimple";
  if (steps.every((step) => step === 1) || steps.every((step) => step === -1)) {
    return "pinTooSimple";
  }
  return null;
}

/** A new PIN a guardian sets. */
export const newPinSchema = z.string().superRefine((value, context) => {
  const problem = pinProblem(value);
  if (problem) context.addIssue({ code: "custom", message: problem });
});

/** A PIN typed at sign-in: only its shape is checked, so a refused PIN reveals nothing. */
export const enteredPinSchema = z.string().regex(/^\d{4,8}$/);

export const deviceLabelSchema = z
  .string()
  .max(1000)
  .transform((value, context) => {
    const name = normalizeName(value);
    if (name === "" || nameProblem(name, DEVICE_LABEL_MAX_LENGTH)) {
      context.addIssue({ code: "custom", message: "deviceLabelInvalid" });
      return z.NEVER;
    }
    return name;
  });

// Request bodies --------------------------------------------------------------------------------

export const passwordSignInSchema = z.strictObject({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type PasswordSignInInput = z.input<typeof passwordSignInSchema>;

export const pinSignInSchema = z.strictObject({
  childMembershipId: z.uuid(),
  pin: enteredPinSchema,
});
export type PinSignInInput = z.input<typeof pinSignInSchema>;

/** What a guardian changes about a child's sign-in, one action per request. */
export const childSignInActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("username"), username: usernameSchema }),
  z.strictObject({ action: z.literal("password"), password: passwordSchema }),
  z.strictObject({ action: z.literal("pin"), pin: newPinSchema }),
  z.strictObject({ action: z.literal("clear"), credential: z.enum(["password", "pin"]) }),
  z.strictObject({
    action: z.literal("access"),
    passwordSignIn: z.boolean(),
    pinSignIn: z.boolean(),
  }),
  z.strictObject({ action: z.literal("unlock") }),
  z.strictObject({ action: z.literal("end-sessions") }),
]);
export type ChildSignInActionInput = z.input<typeof childSignInActionSchema>;

export const approveDeviceSchema = z.strictObject({ label: deviceLabelSchema });
export type ApproveDeviceInput = z.input<typeof approveDeviceSchema>;

/** Whether a Home asks for a PIN for every chore confirmed on its household devices. */
export const pinRuleSchema = z.strictObject({ requirePin: z.boolean() });
export type PinRuleInput = z.input<typeof pinRuleSchema>;

/** An adult sets (`pin`) or removes (`null`) their own household-device PIN. */
export const myDevicePinSchema = z.strictObject({ pin: newPinSchema.nullable() });
export type MyDevicePinInput = z.input<typeof myDevicePinSchema>;
