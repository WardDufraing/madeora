import { z } from "zod";

import { eventFieldsSchema } from "@/calendar/schema";

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

/** S34: the target calendar for events created in Madeora (null: Madeora only). */
export const writeTargetSchema = z.strictObject({ calendarId: z.uuid().nullable() });

export const googleScopes = ["event", "following", "all"] as const;
export type GoogleScope = (typeof googleScopes)[number];

/**
 * S34: a Google event's values as Madeora sends them (the native event fields without repeat, reminder,
 * participants or shares). The database validates again, including DST gaps.
 */
export const googleEventFieldsSchema = eventFieldsSchema.refine(
  (event) =>
    event.reminder == null && event.participants === undefined && event.shares === undefined,
  { message: "nativeOnly", path: ["reminder"] },
);

/** A new event in one of the person's writable Google calendars (`requestId` makes retries safe). */
export const createGoogleEventSchema = z.strictObject({
  requestId: z.uuid(),
  calendarId: z.uuid(),
  event: googleEventFieldsSchema,
});

export const updateGoogleEventSchema = z.strictObject({
  scope: z.enum(googleScopes),
  revision: z.int().min(1),
  event: googleEventFieldsSchema.refine((event) => event.repeat == null, {
    message: "noRepeat",
    path: ["repeat"],
  }),
  dryRun: z.boolean().optional(),
});

export const deleteGoogleEventSchema = z.strictObject({
  scope: z.enum(googleScopes),
  destination: z.enum(["madeora", "everywhere"]),
  revision: z.int().min(1),
  dryRun: z.boolean().optional(),
});

/** The person's answer to a change: a conflict choice, try again, or discard. */
export const googleChangeActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("resolve"), choice: z.enum(["madeora", "google"]) }),
  z.strictObject({ action: z.literal("retry") }),
  z.strictObject({ action: z.literal("discard") }),
]);

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
