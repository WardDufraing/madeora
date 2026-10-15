/**
 * Settings of the job runs inside Trigger.dev (architecture.md §20). They are set per Trigger.dev
 * environment in its dashboard (docs/trigger-setup.md), never in Vercel: the service-role key
 * lives only where the dispatcher and the jobs run.
 */
import { parseEnv, type EnvSource } from "@madeora/config/env";
import { z } from "zod";

// A Supabase secret API key, or the legacy service_role JWT.
const SERVICE_KEY = /^(?:sb_secret_[A-Za-z0-9_-]{20,200}|eyJ[\w-]+\.[\w-]+\.[\w-]+)$/;

export const workerEnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "preview", "staging", "production"]),
  /** The Supabase project of this environment (never production's for development). */
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  /** Secret: the Supabase secret (service-role) key of the same project. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().regex(SERVICE_KEY),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Throws EnvValidationError naming missing or invalid variables, never their values. */
export function parseWorkerEnv(source: EnvSource): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}
