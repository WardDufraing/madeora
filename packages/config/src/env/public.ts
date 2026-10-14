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
  /**
   * The Cloudflare Turnstile site key (public by design: the widget runs in the browser). When set,
   * the sign-in, sign-up, reset-request and resend forms show the Turnstile check and pass its
   * token to Supabase Auth, whose CAPTCHA setting verifies it with the secret key (ADR 0008).
   * Optional except in production (`productionPublicEnvSchema`).
   */
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().refine(isTurnstileSiteKey).optional(),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

/**
 * Production's public settings: as `publicEnvSchema`, but the Turnstile site key is required, so a
 * production build or server without it stops instead of running without bot protection (ADR 0008).
 */
export const productionPublicEnvSchema = publicEnvSchema.extend({
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().refine(isTurnstileSiteKey),
});

/**
 * True for a value shaped like a Turnstile site key: a digit, `x`, then 20 to 32 letters, digits,
 * `_` or `-` (Cloudflare's keys are 24 characters, such as the test key `1x00000000000000000000AA`).
 * Turnstile *secret* keys share the prefix but are longer (35 characters, such as
 * `1x0000000000000000000000000000000AA`), so a pasted secret is refused rather than bundled into
 * browser code.
 */
export function isTurnstileSiteKey(value: string): boolean {
  return /^[0-9]x[A-Za-z0-9_-]{20,32}$/.test(value);
}

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
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    },
  );
}

/**
 * Validates the public settings before `next build` inlines them. A production build (Vercel's
 * `VERCEL_ENV=production`, or `APP_ENV=production` anywhere else) also needs the Turnstile site key.
 */
export function checkPublicEnvForBuild(source: EnvSource): PublicEnv {
  const production = source.VERCEL_ENV === "production" || source.APP_ENV === "production";
  return production
    ? parseEnv(productionPublicEnvSchema, source)
    : parseEnv(publicEnvSchema, source);
}

/**
 * Only the Turnstile site key, for the auth forms: undefined when unset or empty. Read with a
 * literal `process.env.NEXT_PUBLIC_…` reference so Next.js inlines it in browser code. Throws
 * EnvValidationError (naming the variable, never its value) when the value is not a site key.
 */
export function getTurnstileSiteKey(
  value: string | undefined = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
): string | undefined {
  return parseEnv(publicEnvSchema.pick({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: true }), {
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: value,
  }).NEXT_PUBLIC_TURNSTILE_SITE_KEY;
}
