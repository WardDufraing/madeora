/**
 * Google Calendar settings (S33, architecture.md §20, §31). The same three variables configure the web
 * app's server (connect, callback, disconnect) and the Trigger.dev jobs (sync): the OAuth client of the
 * separate "Madeora Calendar" Google Cloud project (never the sign-in client) and the key that encrypts
 * refresh tokens. All three set: on. None set: off (the settings page says Google Calendar is not
 * available here). Anything in between is refused at startup. Validation names a variable, never its
 * value.
 */
import { parseEnv, type EnvSource } from "@madeora/config/env";
import { z } from "zod";

const VARIABLES = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_TOKEN_KEY",
] as const;

export const googleCalendarEnvSchema = z
  .object({
    /** The OAuth client id (`….apps.googleusercontent.com`). Not secret, but server-only here. */
    GOOGLE_CALENDAR_CLIENT_ID: z
      .string()
      .regex(/^[0-9]{5,30}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/)
      .optional(),
    /** Secret: the OAuth client secret. */
    GOOGLE_CALENDAR_CLIENT_SECRET: z
      .string()
      .regex(/^[A-Za-z0-9_-]{10,200}$/)
      .optional(),
    /** Secret: 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts the refresh tokens. */
    GOOGLE_CALENDAR_TOKEN_KEY: z
      .string()
      .regex(/^[A-Za-z0-9+/]{43}=$/)
      .refine((value) => Buffer.from(value, "base64").length === 32)
      .optional(),
  })
  .superRefine((env, context) => {
    const set = VARIABLES.filter((name) => env[name] !== undefined);
    if (set.length === 0 || set.length === VARIABLES.length) return;
    for (const name of VARIABLES) {
      if (env[name] === undefined) {
        context.addIssue({ code: "custom", path: [name], message: `${name} is required` });
      }
    }
  });

export type GoogleCalendarEnv = z.infer<typeof googleCalendarEnvSchema>;

/** What the Google Calendar code needs; null when the integration is off. */
export interface GoogleCalendarConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The 32-byte AES-256-GCM key. */
  readonly tokenKey: Buffer;
}

/** Throws EnvValidationError naming missing or invalid variables, never their values. */
export function parseGoogleCalendarEnv(source: EnvSource): GoogleCalendarEnv {
  return parseEnv(googleCalendarEnvSchema, source);
}

export function googleCalendarConfigFromEnv(env: GoogleCalendarEnv): GoogleCalendarConfig | null {
  if (
    !env.GOOGLE_CALENDAR_CLIENT_ID ||
    !env.GOOGLE_CALENDAR_CLIENT_SECRET ||
    !env.GOOGLE_CALENDAR_TOKEN_KEY
  ) {
    return null;
  }
  return {
    clientId: env.GOOGLE_CALENDAR_CLIENT_ID,
    clientSecret: env.GOOGLE_CALENDAR_CLIENT_SECRET,
    tokenKey: Buffer.from(env.GOOGLE_CALENDAR_TOKEN_KEY, "base64"),
  };
}
