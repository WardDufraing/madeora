// Public environment values: only `NEXT_PUBLIC_` settings, which Next.js inlines into browser code
// at build time. Never put a secret here.
import { z } from "zod";
import { parseEnv, type EnvSource } from "./core.ts";

/**
 * True when `key` looks like a privileged Supabase key: a secret API key (`sb_secret_…`) or a
 * legacy JWT key whose `role` claim is `service_role`. Such a key bypasses RLS, so it must never be
 * accepted as a public value, where Next.js would copy it into browser code (architecture.md §4).
 */
export function isPrivilegedSupabaseKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload: unknown = JSON.parse(base64UrlDecode(parts[1] ?? ""));
    return (
      typeof payload === "object" &&
      payload !== null &&
      "role" in payload &&
      payload.role !== "anon"
    );
  } catch {
    return false;
  }
}

function base64UrlDecode(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
}

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url({ protocol: /^https?$/ }),
  /**
   * The Supabase project's address (local stack, preview project, …): scheme and host only, such
   * as `https://<ref>.supabase.co`. Supabase's clients add `/auth/v1`, `/rest/v1` and so on
   * themselves, so a copied API address with a path (`…/rest/v1/`) would break every request.
   */
  NEXT_PUBLIC_SUPABASE_URL: z
    .url({ protocol: /^https?$/ })
    .refine((value) => value === new URL(value).origin),
  /**
   * The project's publishable key (`sb_publishable_…`, or the legacy `anon` JWT). It is public by
   * design: it only identifies the project, and RLS decides what it can reach.
   */
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+$/)
    .refine((key) => !isPrivilegedSupabaseKey(key)),
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
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    },
  );
}
