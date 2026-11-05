import { z } from "zod";

import { calendarLevels, calendarMemberLevels } from "@madeora/domain/permissions";
import { recurrenceFrequencies } from "@madeora/domain/tasks";

import { googleWarningSchema } from "@/google-calendar/shapes";

/**
 * The shapes the calendar reads answer with (S32), checked on the server before anything is shown,
 * so a database change cannot reach the interface unnoticed. Client-safe.
 */

const date = z.string();
const instant = z.string().nullable();

/** One occurrence in a list: `from` and `to` are the local dates it covers in the shown timezone. */
export const occurrenceSchema = z.object({
  eventId: z.uuid(),
  /** A recurring event's occurrence: the date it starts on in its own rule; null for a single event. */
  on: date.nullable(),
  kind: z.enum(["home", "personal", "shared"]),
  /** Someone else's personal event shared with this Home: their membership id (null if departed). */
  sharedBy: z.uuid().nullable(),
  title: z.string(),
  location: z.string().nullable(),
  allDay: z.boolean(),
  from: date,
  to: date,
  startsAt: instant,
  endsAt: instant,
  timezone: z.string(),
  recurring: z.boolean(),
  changed: z.boolean(),
  participants: z.array(z.uuid()),
  /** Where it comes from (S33): a Madeora event, or a read-only event synced from Google Calendar. */
  source: z.enum(["madeora", "google"]).default("madeora"),
  /** A Google event's calendar name; null for Madeora events. */
  calendar: z.string().nullable().default(null),
  /** S34: a Google event's change state, for its owner only (null: in sync). */
  googleState: z.enum(["saving", "deleting", "conflict", "failed"]).nullable().default(null),
});
export type Occurrence = z.output<typeof occurrenceSchema>;

export const vacationBannerSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  status: z.string(),
  startsOn: date,
  endsOn: date,
  participants: z.array(
    z.object({
      member: z.object({ me: z.boolean(), member: z.uuid().nullable() }).nullable(),
      startsOn: date,
      endsOn: date,
    }),
  ),
  memberCount: z.int(),
  me: z.boolean(),
});
export type VacationBanner = z.output<typeof vacationBannerSchema>;

const level = z.enum(calendarLevels).nullable();

export const calendarListSchema = z.object({
  timezone: z.string(),
  today: date,
  level,
  canCreate: z.boolean(),
  truncated: z.boolean(),
  occurrences: z.array(occurrenceSchema),
  showVacations: z.boolean(),
  showTasks: z.boolean(),
  showChores: z.boolean(),
  vacations: z.array(vacationBannerSchema),
  /** Google calendars behind this view that are not up to date (S33). */
  googleWarnings: z.array(googleWarningSchema).default([]),
});
export type CalendarList = z.output<typeof calendarListSchema>;

export const upcomingSchema = z.object({
  timezone: z.string(),
  today: date,
  canCreate: z.boolean(),
  more: z.boolean(),
  occurrences: z.array(occurrenceSchema),
  googleWarnings: z.array(googleWarningSchema).default([]),
});
export type Upcoming = z.output<typeof upcomingSchema>;

const detailTimes = z.object({
  description: z.string().nullable(),
  startsOn: date,
  endsOn: date,
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
});

export const repeatShape = z.object({
  frequency: z.enum(recurrenceFrequencies),
  interval: z.int(),
  weekdays: z.array(z.int()).nullable(),
  endsOn: date.nullable(),
  count: z.int().nullable(),
  until: date.nullable(),
});
export type RepeatShape = z.output<typeof repeatShape>;

export const eventDetailSchema = z.object({
  id: z.uuid(),
  homeId: z.uuid().nullable(),
  kind: z.enum(["home", "personal", "shared"]),
  sharedBy: z.uuid().nullable(),
  revision: z.int(),
  /** Minutes before each occurrence; null for none, and always null on someone's shared event. */
  reminder: z.int().nullable(),
  displayTimezone: z.string(),
  series: occurrenceSchema.extend(detailTimes.shape),
  repeat: repeatShape.nullable(),
  occurrence: occurrenceSchema.extend(detailTimes.shape).extend({ first: z.boolean() }).nullable(),
  /** The owner only: the Homes the event is shared with. */
  shares: z.array(z.uuid()).nullable(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  exceptions: z.int(),
});
export type EventDetail = z.output<typeof eventDetailSchema>;

export const calendarAccessListSchema = z.object({
  canManage: z.boolean(),
  members: z.array(
    z.object({
      membershipId: z.uuid(),
      isSelf: z.boolean(),
      role: z.enum(["owner", "administrator", "member"]),
      level: z.enum(calendarLevels),
      canChange: z.boolean(),
    }),
  ),
});
export type CalendarAccessList = z.output<typeof calendarAccessListSchema>;

/** A preview of the occurrences a change or deletion affects. */
export const previewSchema = z.object({
  outcome: z.literal("preview"),
  scope: z.enum(["only", "following", "all"]),
  dates: z.array(date),
  more: z.boolean(),
  endless: z.boolean().optional(),
  removedChanges: z.int().optional(),
  trash: z.boolean().optional(),
});
export type Preview = z.output<typeof previewSchema>;

export { calendarMemberLevels };
