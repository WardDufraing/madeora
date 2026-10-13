import type { EnvSource } from "@madeora/config/env";
import { parseEnv } from "@madeora/config/env";
import { publicEnvSchema, type PublicEnv } from "@madeora/config/env/public";
import { serverEnvSchema, type ServerEnv } from "@madeora/config/env/server";

const startupSchema = serverEnvSchema.extend(publicEnvSchema.shape);

/** Validates every required server and public variable. Throws EnvValidationError naming the failures. */
export function validateStartupEnv(source: EnvSource): ServerEnv & PublicEnv {
  return parseEnv(startupSchema, source);
}
