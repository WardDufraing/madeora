import { parseEnv, publicEnvSchema, serverEnvSchema } from "@madeora/config/env";
import type { EnvSource, PublicEnv, ServerEnv } from "@madeora/config/env";

const startupSchema = serverEnvSchema.extend(publicEnvSchema.shape);

/** Validates every required server and public variable. Throws EnvValidationError naming the failures. */
export function validateStartupEnv(source: EnvSource): ServerEnv & PublicEnv {
  return parseEnv(startupSchema, source);
}
