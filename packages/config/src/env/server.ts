// Server-only environment values. "server-only" makes any Client Component that imports this
// module, directly or through another module, fail the Next.js build (architecture.md §20).
import "server-only";

import { z } from "zod";

import { parseEnv, type EnvSource } from "./core.ts";

export const appEnvironments = ["development", "test", "preview", "staging", "production"] as const;

/** Where the app's own emails go (S10, CLAUDE.md email strategy A). Unset means `off`. */
export const emailTransports = ["resend", "mailpit", "off"] as const;

// `Madeora <no-reply@mail.madeora.studio>` or a bare address.
const address = String.raw`[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+`;
const senderPattern = new RegExp(String.raw`^(?:[^<>@\r\n]{1,64} <${address}>|${address})$`);

/** Server-only settings. Secrets added here can never be bundled into browser code. */
export const serverEnvSchema = z
  .object({
    APP_ENV: z.enum(appEnvironments),
    EMAIL_TRANSPORT: z.enum(emailTransports).optional(),
    /** The sender of the app's emails, on the verified sending domain. */
    EMAIL_FROM: z.string().max(200).regex(senderPattern).optional(),
    /** Resend API key with sending access (secret). */
    RESEND_API_KEY: z
      .string()
      .regex(/^re_[A-Za-z0-9_]{8,200}$/)
      .optional(),
    /** Mailpit's web address on this machine (development and tests only). */
    MAILPIT_URL: z
      .url({ protocol: /^https?$/ })
      .refine((value) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname))
      .optional(),
  })
  .superRefine((env, context) => {
    const missing = (variable: string) => {
      context.addIssue({ code: "custom", path: [variable], message: `${variable} is required` });
    };
    if (env.EMAIL_TRANSPORT === "resend") {
      if (!env.RESEND_API_KEY) missing("RESEND_API_KEY");
      if (!env.EMAIL_FROM) missing("EMAIL_FROM");
    }
    if (env.EMAIL_TRANSPORT === "mailpit") {
      if (!env.MAILPIT_URL) missing("MAILPIT_URL");
      if (!env.EMAIL_FROM) missing("EMAIL_FROM");
      // A mail catcher is never a hosted environment's email: it would silently swallow mail.
      if (!["development", "test"].includes(env.APP_ENV)) {
        context.addIssue({
          code: "custom",
          path: ["EMAIL_TRANSPORT"],
          message: "mailpit is for development and tests only",
        });
      }
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export type EmailSettings =
  | { readonly transport: "off" }
  | { readonly transport: "resend"; readonly apiKey: string; readonly from: string }
  | { readonly transport: "mailpit"; readonly url: string; readonly from: string };

/** The email settings from validated server settings; anything incomplete is `off`. */
export function emailSettings(env: ServerEnv): EmailSettings {
  if (env.EMAIL_TRANSPORT === "resend" && env.RESEND_API_KEY && env.EMAIL_FROM) {
    return { transport: "resend", apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM };
  }
  if (env.EMAIL_TRANSPORT === "mailpit" && env.MAILPIT_URL && env.EMAIL_FROM) {
    return { transport: "mailpit", url: env.MAILPIT_URL, from: env.EMAIL_FROM };
  }
  return { transport: "off" };
}

/**
 * The validated server settings, parsed from `process.env` on first use and then reused.
 * Throws EnvValidationError naming every missing or invalid variable, never their values.
 * Pass `source` to validate another set of values; that result is not cached.
 */
export function getServerEnv(source?: EnvSource): ServerEnv {
  if (source !== undefined) return parseEnv(serverEnvSchema, source);
  cached ??= parseEnv(serverEnvSchema, process.env);
  return cached;
}
