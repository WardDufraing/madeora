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
  | "passwordsDiffer"
  | "emailUnchanged";

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

/** Typing the current password again before a sensitive change (S08). */
export const reauthenticateSchema = z.object({
  password: z.string().min(1, { error: "passwordRequired" satisfies AuthFieldError }),
});
export type ReauthenticateValues = z.infer<typeof reauthenticateSchema>;

/** A six-digit authenticator code (S37); spaces are allowed, as apps often show "123 456". */
export type TwoFactorFieldError = "codeRequired" | "codeInvalid" | "recoveryCodeInvalid";

export const totpCode = z
  .string()
  .transform((value) => value.replace(/\s/g, ""))
  .pipe(
    z
      .string()
      .min(1, { error: "codeRequired" satisfies TwoFactorFieldError })
      .regex(/^\d{6}$/, { error: "codeInvalid" satisfies TwoFactorFieldError }),
  );

export const totpCodeSchema = z.object({ code: totpCode });
export type TotpCodeValues = z.input<typeof totpCodeSchema>;

/** A two-factor recovery code: 12 letters and digits, dashes, spaces and case do not matter. */
export const recoveryCodeSchema = z.object({
  recoveryCode: z
    .string()
    .transform((value) => value.replace(/[\s-]/g, "").toUpperCase())
    .pipe(
      z
        .string()
        .min(1, { error: "codeRequired" satisfies TwoFactorFieldError })
        .regex(/^[2-9A-HJ-NP-Z]{12}$/, {
          error: "recoveryCodeInvalid" satisfies TwoFactorFieldError,
        }),
    ),
});
export type RecoveryCodeValues = z.input<typeof recoveryCodeSchema>;

/**
 * Reauthentication before a sensitive change (S37): the current password and, when the account
 * has two-factor sign-in, a code from the authenticator. `withCode` decides whether the code is
 * asked for; the database decides whether it was needed. `withPassword` is false for an account
 * without a password, which confirms with Google before the form instead (and then asks neither).
 */
export function reauthenticationSchema(withCode: boolean, withPassword = true) {
  return z.object({
    password: withPassword
      ? z.string().min(1, { error: "passwordRequired" satisfies AuthFieldError })
      : z.string(),
    code: withCode && withPassword ? totpCode : z.string(),
  });
}
export type ReauthenticationValues = { password: string; code: string };

/** Changing the password while signed in (S37): reauthentication plus the new password twice. */
export function changePasswordSchema(withCode: boolean, withPassword = true) {
  return reauthenticationSchema(withCode, withPassword)
    .extend({ newPassword: newPassword, confirmPassword: z.string() })
    .refine((values) => values.newPassword === values.confirmPassword, {
      error: "passwordsDiffer" satisfies AuthFieldError,
      path: ["confirmPassword"],
    });
}
export type ChangePasswordValues = ReauthenticationValues & {
  newPassword: string;
  confirmPassword: string;
};

/** Changing the account email (S37): reauthentication plus the new address. */
export function changeEmailSchema(withCode: boolean, currentEmail: string, withPassword = true) {
  return reauthenticationSchema(withCode, withPassword)
    .extend({ email })
    .refine((values) => values.email.toLowerCase() !== currentEmail.toLowerCase(), {
      error: "emailUnchanged" satisfies AuthFieldError,
      path: ["email"],
    });
}
export type ChangeEmailValues = ReauthenticationValues & { email: string };

/**
 * Adding or changing the backup email (S37): reauthentication plus the address, which the
 * database also checks (and refuses when it is the sign-in address). Removing asks no address.
 */
export function backupEmailSchema(withCode: boolean, withPassword: boolean, removing: boolean) {
  return reauthenticationSchema(withCode, withPassword).extend({
    email: removing ? z.string() : email,
  });
}
export type BackupEmailValues = ReauthenticationValues & { email: string };

/** An account recovery code: 16 letters and digits, shown XXXX-XXXX-XXXX-XXXX. */
export const accountRecoveryCode = z
  .string()
  .transform((value) => value.replace(/[\s-]/g, "").toUpperCase())
  .pipe(
    z
      .string()
      .min(1, { error: "codeRequired" satisfies TwoFactorFieldError })
      .regex(/^[2-9A-HJ-NP-Z]{16}$/, {
        error: "recoveryCodeInvalid" satisfies TwoFactorFieldError,
      }),
  );

/** Continuing an account recovery from the backup address's link (S37). */
export const continueRecoverySchema = z.object({
  recoveryCode: accountRecoveryCode,
  lostAuthenticator: z.boolean(),
});
export type ContinueRecoveryValues = z.input<typeof continueRecoverySchema>;

/** A single-use link token from a security email (S37): 43 base64url characters. */
export function parseLinkToken(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
