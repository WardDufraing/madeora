import type { EnvSource } from "@madeora/config/env";
import { parseEnv } from "@madeora/config/env";
import {
  productionPublicEnvSchema,
  publicEnvSchema,
  type PublicEnv,
} from "@madeora/config/env/public";
import { serverEnvSchema, type ServerEnv } from "@madeora/config/env/server";

import { parseWebStorageSettings } from "@/storage/config";

const startupSchema = serverEnvSchema.extend(publicEnvSchema.shape);
const productionStartupSchema = serverEnvSchema.extend(productionPublicEnvSchema.shape);

/**
 * Validates every required server and public variable, and the storage settings when storage is
 * on (S15). Production also requires the Turnstile site key (ADR 0008). Throws
 * EnvValidationError naming the failures.
 */
export function validateStartupEnv(source: EnvSource): ServerEnv & PublicEnv {
  const env =
    source.APP_ENV === "production"
      ? parseEnv(productionStartupSchema, source)
      : parseEnv(startupSchema, source);
  parseWebStorageSettings(source);
  return env;
}
