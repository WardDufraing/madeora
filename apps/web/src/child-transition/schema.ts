import { z } from "zod";

/**
 * Inputs of the move to an independent account (S42 part 3). Client-safe; the server validates
 * every request again and the database decides.
 */

/** A birth date as `YYYY-MM-DD`, a real calendar date. Used for the age check only, never stored. */
export const birthDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  });

export const startTransitionSchema = z.strictObject({ birthDate: birthDateSchema });
export type StartTransitionInput = z.input<typeof startTransitionSchema>;

/** The secret part of a claim or verification link. */
export const transitionTokenSchema = z
  .string()
  .min(20)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

export const claimEmailSchema = z.string().trim().min(3).max(254).pipe(z.email());

export const claimSchema = z.strictObject({
  token: transitionTokenSchema,
  email: claimEmailSchema,
});
export type ClaimInput = z.input<typeof claimSchema>;

export const completeTransitionSchema = z.strictObject({ token: transitionTokenSchema });
