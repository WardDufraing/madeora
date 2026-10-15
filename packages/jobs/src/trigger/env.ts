/**
 * Settings of the job runs inside Trigger.dev (architecture.md §20). They are set per Trigger.dev
 * environment in its dashboard (docs/trigger-setup.md), never in Vercel: the service-role key and
 * the email provider's key live only where the jobs run.
 */
import { parseEnv, type EnvSource } from "@madeora/config/env";
import { z } from "zod";

// A Supabase secret API key, or the legacy service_role JWT.
const SERVICE_KEY = /^(?:sb_secret_[A-Za-z0-9_-]{20,200}|eyJ[\w-]+\.[\w-]+\.[\w-]+)$/;

// `Madeora <no-reply@mail.madeora.studio>` or a bare address (same rule as the web app's EMAIL_FROM).
const address = String.raw`[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+`;
const senderPattern = new RegExp(String.raw`^(?:[^<>@\r\n]{1,64} <${address}>|${address})$`);

export const workerEnvSchema = z
  .object({
    APP_ENV: z.enum(["development", "test", "preview", "staging", "production"]),
    /** The Supabase project of this environment (never production's for development). */
    SUPABASE_URL: z.url({ protocol: /^https?$/ }),
    /** Secret: the Supabase secret (service-role) key of the same project. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().regex(SERVICE_KEY),
    /** How emails leave: Resend, the local Mailpit, or nowhere (the default). */
    EMAIL_TRANSPORT: z.enum(["resend", "mailpit", "off"]).optional(),
    /** The sender, on the verified sending domain, for example `Madeora <no-reply@mail.madeora.studio>`. */
    EMAIL_FROM: z.string().max(200).regex(senderPattern).optional(),
    /** Secret: the Resend API key of this environment. */
    RESEND_API_KEY: z
      .string()
      .regex(/^re_[A-Za-z0-9_]{8,200}$/)
      .optional(),
    /** Mailpit's web address on this machine (development and tests only). */
    MAILPIT_URL: z
      .url({ protocol: /^https?$/ })
      .refine((value) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname))
      .optional(),
    /** The web app's address, for the links in emails. */
    APP_URL: z.url({ protocol: /^https?$/ }).optional(),
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
    if (env.EMAIL_TRANSPORT === "resend" || env.EMAIL_TRANSPORT === "mailpit") {
      if (!env.APP_URL) missing("APP_URL");
      // Links in real emails must be secure ones.
      else if (env.APP_ENV === "production" && !env.APP_URL.startsWith("https://")) {
        context.addIssue({
          code: "custom",
          path: ["APP_URL"],
          message: "APP_URL must be https in production",
        });
      }
    }
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Throws EnvValidationError naming missing or invalid variables, never their values. */
export function parseWorkerEnv(source: EnvSource): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}
