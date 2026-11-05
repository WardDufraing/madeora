import { z } from "zod";

/**
 * Google Calendar requests (S33), shared by the settings form and the routes (which validate again).
 * Client-safe. The limits match `private.google_calendar_limit` in the S33 migration.
 */
export const GOOGLE_CALENDAR_LIMITS = { syncedCalendars: 20, sharedHomes: 20 } as const;

/** One calendar's choices. A calendar that does not sync shows nowhere. */
export const googleCalendarSettingsSchema = z
  .strictObject({
    sync: z.boolean(),
    showPersonal: z.boolean(),
    homes: z.array(z.uuid()).max(GOOGLE_CALENDAR_LIMITS.sharedHomes),
  })
  .refine((value) => value.sync || (!value.showPersonal && value.homes.length === 0), {
    path: ["sync"],
    message: "a calendar that does not sync shows nowhere",
  });
export type GoogleCalendarSettings = z.output<typeof googleCalendarSettingsSchema>;

/** An empty JSON object, for the actions that take no input. */
export const emptyBodySchema = z.strictObject({});

/** The notices the settings page shows after the OAuth callback (`?google=`). */
export const connectNotices = [
  "connected",
  "reconnected",
  "replaced",
  "cancelled",
  "missing_scope",
  "state",
  "failed",
  "unavailable",
] as const;
export type ConnectNotice = (typeof connectNotices)[number];

export function connectNotice(value: unknown): ConnectNotice | null {
  return typeof value === "string" && (connectNotices as readonly string[]).includes(value)
    ? (value as ConnectNotice)
    : null;
}

export const settingsPath = "/settings/google-calendar";
