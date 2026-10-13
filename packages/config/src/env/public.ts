// Public environment values: only `NEXT_PUBLIC_` settings, which Next.js inlines into browser code
// at build time. Never put a secret here.
import { z } from "zod";

import { parseEnv, type EnvSource } from "./core.ts";

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url({ protocol: /^https?$/ }),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

/**
 * The validated public settings. Without `source`, each value is read with a literal
 * `process.env.NEXT_PUBLIC_…` reference, because that is the only form Next.js replaces in
 * browser bundles. Throws EnvValidationError naming every missing or invalid variable.
 */
export function getPublicEnv(source?: EnvSource): PublicEnv {
  return parseEnv(
    publicEnvSchema,
    source ?? {
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    },
  );
}
