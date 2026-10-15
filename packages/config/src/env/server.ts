// Server-only environment values. "server-only" makes any Client Component that imports this
// module, directly or through another module, fail the Next.js build (architecture.md §20).
import "server-only";

import { z } from "zod";

import { parseEnv, type EnvSource } from "./core.ts";

export const appEnvironments = ["development", "test", "preview", "staging", "production"] as const;

/**
 * Whether the app's own emails (invitations, notifications) are sent in this environment (S10,
 * S14). The web app never sends them: the database queues each one and a Trigger.dev job sends it
 * with the provider's settings, which therefore live in Trigger.dev (`packages/jobs`), not here.
 * Unset means `off`.
 */
export const emailTransports = ["resend", "mailpit", "off"] as const;

/** Server-only settings. Secrets added here can never be bundled into browser code. */
export const serverEnvSchema = z
  .object({
    APP_ENV: z.enum(appEnvironments),
    EMAIL_TRANSPORT: z.enum(emailTransports).optional(),
  })
  .superRefine((env, context) => {
    // A mail catcher is never a hosted environment's email: it would silently swallow mail.
    if (env.EMAIL_TRANSPORT === "mailpit" && !["development", "test"].includes(env.APP_ENV)) {
      context.addIssue({
        code: "custom",
        path: ["EMAIL_TRANSPORT"],
        message: "mailpit is for development and tests only",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Whether email is sent in this environment (anything but `off`). */
export function emailEnabled(env: ServerEnv): boolean {
  return env.EMAIL_TRANSPORT === "resend" || env.EMAIL_TRANSPORT === "mailpit";
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
