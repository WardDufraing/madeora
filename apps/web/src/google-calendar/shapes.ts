import { z } from "zod";

/**
 * The shapes the Google Calendar reads answer with (S33), checked on the server before anything is
 * shown. Client-safe: no secret ever travels in them (the database never returns the token).
 */

export const googleStates = [
  "synced",
  "syncing",
  "stale",
  "failed",
  "authorization_expired",
  "out_of_date",
] as const;
export type GoogleState = (typeof googleStates)[number];

/** A calendar behind a context that is not up to date (the owner's exact state; others only "out of date"). */
export const googleWarningSchema = z.object({
  calendar: z.string(),
  own: z.boolean(),
  sharedBy: z.uuid().nullable(),
  state: z.enum(googleStates),
  lastSyncedAt: z.string().nullable(),
});
export type GoogleWarning = z.output<typeof googleWarningSchema>;

export const googleCalendarEntrySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  primary: z.boolean(),
  accessRole: z.enum(["freeBusyReader", "reader", "writer", "owner"]),
  available: z.boolean(),
  sync: z.boolean(),
  showPersonal: z.boolean(),
  homes: z.array(z.uuid()),
  state: z.enum(googleStates).nullable(),
  errorCode: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
});
export type GoogleCalendarEntry = z.output<typeof googleCalendarEntrySchema>;

export const googleConnectionSchema = z.object({
  account: z.string(),
  status: z.enum(["connected", "authorization_expired"]),
  connectedAt: z.string(),
  lastSyncedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  listed: z.boolean(),
  syncQueued: z.boolean(),
  canSyncNow: z.boolean(),
  calendars: z.array(googleCalendarEntrySchema),
  homes: z.array(z.object({ id: z.uuid(), name: z.string() })),
  limits: z.object({ syncedCalendars: z.int() }),
});
export type GoogleConnection = z.output<typeof googleConnectionSchema>;

/** One Google event as the viewer sees it in a context. */
export const googleEventSchema = z.object({
  eventId: z.uuid(),
  kind: z.enum(["personal", "shared"]),
  sharedBy: z.uuid().nullable(),
  title: z.string(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  allDay: z.boolean(),
  from: z.string(),
  to: z.string(),
  startsOn: z.string().nullable(),
  endsOn: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  timezone: z.string(),
  displayTimezone: z.string(),
  recurring: z.boolean(),
  tentative: z.boolean(),
  privateInGoogle: z.boolean(),
  calendar: z.string(),
  /** The owner only. */
  link: z.string().nullable(),
  state: z.enum(googleStates),
  lastSyncedAt: z.string().nullable(),
});
export type GoogleEvent = z.output<typeof googleEventSchema>;
