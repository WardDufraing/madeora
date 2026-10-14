import { z } from "zod";

/**
 * Password rules (brief S06, ADR 0007): 12 to 72 characters, no composition rules, not the email
 * address. Supabase Auth enforces the minimum length on the server too (`supabase/config.toml`,
 * and the preview project's settings); 72 is the most bcrypt, which Supabase uses, can check.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 72;

/** Error message keys, translated in the `Auth` namespace by the forms. */
export type AuthFieldError =
  | "emailRequired"
  | "emailInvalid"
  | "passwordRequired"
  | "passwordTooShort"
  | "passwordTooLong"
  | "passwordIsEmail"
  | "passwordsDiffer";

const email = z
  .string()
  .trim()
  .min(1, { error: "emailRequired" satisfies AuthFieldError })
  .max(254, { error: "emailInvalid" satisfies AuthFieldError })
  .pipe(z.email({ error: "emailInvalid" satisfies AuthFieldError }));

/** Byte length, because the bcrypt limit is 72 bytes, not 72 characters. */
const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

const newPassword = z
  .string()
  .min(1, { error: "passwordRequired" satisfies AuthFieldError })
  .refine((value) => Array.from(value).length >= PASSWORD_MIN_LENGTH, {
    error: "passwordTooShort" satisfies AuthFieldError,
    abort: true,
  })
  .refine((value) => utf8Length(value) <= PASSWORD_MAX_LENGTH, {
    error: "passwordTooLong" satisfies AuthFieldError,
  });

export const signUpSchema = z
  .object({ email, password: newPassword })
  .refine((values) => values.password.trim().toLowerCase() !== values.email.toLowerCase(), {
    error: "passwordIsEmail" satisfies AuthFieldError,
    path: ["password"],
  });

/** Sign-in only checks that something was typed; the rules apply when a password is chosen. */
export const signInSchema = z.object({
  email,
  password: z.string().min(1, { error: "passwordRequired" satisfies AuthFieldError }),
});

export const emailOnlySchema = z.object({ email });

export const newPasswordSchema = z
  .object({ password: newPassword, confirmPassword: z.string() })
  .refine((values) => values.password === values.confirmPassword, {
    error: "passwordsDiffer" satisfies AuthFieldError,
    path: ["confirmPassword"],
  });

export type SignUpValues = z.infer<typeof signUpSchema>;
export type SignInValues = z.infer<typeof signInSchema>;
export type EmailOnlyValues = z.infer<typeof emailOnlySchema>;
export type NewPasswordValues = z.infer<typeof newPasswordSchema>;

/** One-time token from an email link: Supabase's token hashes are hex, sometimes `pkce_`-prefixed. */
export function parseTokenHash(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  return /^(?:pkce_)?[a-f0-9]{20,128}$/i.test(value) ? value : null;
}
