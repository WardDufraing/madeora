import { parseEnv, type EnvSource } from "@madeora/config/env";
import { parseStorageEnv, storageConfigFromEnv, type StorageConfig } from "@madeora/storage";
import { z } from "zod";

// A Supabase secret API key, or the legacy service_role JWT (the jobs accept the same shapes).
const SERVICE_KEY = /^(?:sb_secret_[A-Za-z0-9_-]{20,200}|eyJ[\w-]+\.[\w-]+\.[\w-]+)$/;

/**
 * The web server's storage settings (S15, ADR 0019): the shared `STORAGE_*` values, plus the
 * Supabase secret key that only the finalize step uses, because the facts it records (the real
 * size, type and checksum the server verified) must not be something a browser can claim. It is
 * required only where storage is on, and never reaches browser code (this module is imported by
 * server modules only; the key is read nowhere else in the web app).
 */
const webStorageEnvSchema = z
  .object({
    STORAGE_DRIVER: z.enum(["s3", "off"]).optional(),
    /** Secret: the Supabase secret (service-role) key of this environment's project. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().regex(SERVICE_KEY).optional(),
  })
  .superRefine((env, context) => {
    if (env.STORAGE_DRIVER === "s3" && !env.SUPABASE_SERVICE_ROLE_KEY) {
      context.addIssue({
        code: "custom",
        path: ["SUPABASE_SERVICE_ROLE_KEY"],
        message: "SUPABASE_SERVICE_ROLE_KEY is required when storage is on",
      });
    }
  });

export interface WebStorageSettings {
  readonly store: StorageConfig;
  readonly serviceRoleKey: string;
}

/**
 * Storage settings, or null when storage is off. Throws EnvValidationError naming the variables
 * that are missing or invalid, never their values.
 */
export function parseWebStorageSettings(source: EnvSource): WebStorageSettings | null {
  const store = storageConfigFromEnv(parseStorageEnv(source));
  const web = parseEnv(webStorageEnvSchema, source);
  if (!store || !web.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { store, serviceRoleKey: web.SUPABASE_SERVICE_ROLE_KEY };
}
