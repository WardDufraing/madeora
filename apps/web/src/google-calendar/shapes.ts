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
  writable: z.boolean().default(false),
  openChanges: z.int().default(0),
});
export type GoogleCalendarEntry = z.output<typeof googleCalendarEntrySchema>;

export const changeActions = ["create", "update", "delete"] as const;
export const changeStates = ["pending", "conflict", "failed"] as const;

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
  writeCalendarId: z.uuid().nullable().default(null),
  changes: z
    .array(
      z.object({
        id: z.uuid(),
        eventId: z.uuid().nullable(),
        title: z.string().nullable(),
        calendar: z.string(),
        action: z.enum(changeActions),
        scope: z.enum(["event", "following", "all"]),
        state: z.enum(changeStates),
        errorCode: z.string().nullable(),
        updatedAt: z.string(),
      }),
    )
    .default([]),
  hidden: z
    .array(
      z.object({
        id: z.uuid(),
        kind: z.enum(["event", "series", "following"]),
        title: z.string().nullable(),
        startsOn: z.string(),
        calendar: z.string(),
      }),
    )
    .default([]),
});
export type GoogleConnection = z.output<typeof googleConnectionSchema>;

/** An event version in a change (the database's snapshot shape; `deleted` when Google deleted it). */
export const googleVersionSchema = z.object({
  deleted: z.boolean().optional(),
  title: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  allDay: z.boolean().optional(),
  startsOn: z.string().nullable().optional(),
  endsOn: z.string().nullable().optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  timeZone: z.string().nullable().optional(),
});
export type GoogleVersion = z.output<typeof googleVersionSchema>;

export const googleFields = ["title", "location", "description", "time"] as const;
export type GoogleField = (typeof googleFields)[number];

/** The open change on an event, as its owner sees it (S34). */
export const googleChangeSchema = z.object({
  id: z.uuid(),
  action: z.enum(changeActions),
  scope: z.enum(["event", "following", "all"]),
  state: z.enum(changeStates),
  errorCode: z.string().nullable(),
  fields: z.array(z.enum(googleFields)),
  conflictFields: z.array(z.enum(googleFields)),
  mine: googleVersionSchema.nullable(),
  theirs: googleVersionSchema.nullable(),
  /** False: the change is on the event's series. */
  own: z.boolean(),
});
export type GoogleChange = z.output<typeof googleChangeSchema>;

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
  /** S34, the owner only (null for others). */
  revision: z.int().nullable().default(null),
  editable: z.boolean().default(false),
  pendingCreate: z.boolean().default(false),
  change: googleChangeSchema.nullable().default(null),
});
export type GoogleEvent = z.output<typeof googleEventSchema>;
