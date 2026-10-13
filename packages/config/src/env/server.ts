// Server-only environment values. "server-only" makes any Client Component that imports this
// module, directly or through another module, fail the Next.js build (architecture.md §20).
import "server-only";

import { z } from "zod";

import { parseEnv, type EnvSource } from "./core.ts";

export const appEnvironments = ["development", "test", "preview", "staging", "production"] as const;

/** Server-only settings. Secrets added here can never be bundled into browser code. */
export const serverEnvSchema = z.object({
  APP_ENV: z.enum(appEnvironments),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

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
