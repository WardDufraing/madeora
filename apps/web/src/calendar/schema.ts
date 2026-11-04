import { z } from "zod";

import { calendarMemberLevels } from "@madeora/domain/permissions";
import {
  daysBetween,
  isoWeekday,
  recurrenceFrequencies,
  RECURRENCE_LIMITS,
  type IsoWeekday,
} from "@madeora/domain/tasks";

import { dateOnlySchema, plainTextSchema } from "@/tasks/schema";

/**
 * The calendar contract (S32, versioned for later mobile clients). Client-safe. Every limit matches
 * the database (`private.calendar_limit` and the checks in supabase/migrations/*_calendar.sql), which
 * checks everything again, including what only it can know: whether a local time exists in a
 * timezone (daylight-saving gaps), whether participants are current members, whether the Homes
 * shared with are the person's own.
 */

export const CALENDAR_LIMITS = {
  events: 5000,
  exceptions: 500,
  participants: 20,
  shares: 20,
  title: 200,
  location: 200,
  description: 4000,
  /** Days an all-day event may span. */
  allDayDays: 366,
  /** Days a timed event may last. */
  timedDays: 14,
  /** Days one calendar read may cover. */
  windowDays: 62,
} as const;

const id = z.uuid();

/** One line of plain text: no line breaks or tabs. */
function singleLine(max: number) {
  return plainTextSchema(max).refine((value) => !/[\t\r\n]/.test(value), "invalidCharacters");
}

/** Optional text: empty (or only whitespace) is none. */
function optional(max: number, single: boolean) {
  return z
    .string()
    .transform((value) => (value.trim() === "" ? null : value))
    .pipe((single ? singleLine(max) : plainTextSchema(max)).nullable());
}

export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "invalidTime");

/** An IANA timezone name the platform knows. */
export const timeZoneSchema = z
  .string()
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return /^[A-Za-z][A-Za-z0-9_+/-]*$/.test(zone);
    } catch {
      return false;
    }
  }, "invalidZone");

export const eventRepeatSchema = z.strictObject({
  frequency: z.enum(recurrenceFrequencies),
  interval: z.int().min(1).max(RECURRENCE_LIMITS.interval),
  weekdays: z
    .array(z.int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, "invalid")
    .transform((days) => [...days].sort((a, b) => a - b) as IsoWeekday[])
    .nullable(),
  endsOn: dateOnlySchema.nullable(),
  count: z.int().min(1).max(RECURRENCE_LIMITS.count).nullable(),
});
export type EventRepeat = z.output<typeof eventRepeatSchema>;

/** Reminder offsets in minutes before an occurrence's start (the pet-care set, S31). */
export const calendarReminders = [0, 15, 60, 1440] as const;
export type CalendarReminder = (typeof calendarReminders)[number];

/** An event's values as a request sends them. Times are local to `timezone`. */
export const eventFieldsSchema = z
  .strictObject({
    title: singleLine(CALENDAR_LIMITS.title),
    location: optional(CALENDAR_LIMITS.location, true).nullable().optional(),
    description: optional(CALENDAR_LIMITS.description, false).nullable().optional(),
    allDay: z.boolean(),
    startsOn: dateOnlySchema,
    endsOn: dateOnlySchema,
    startTime: timeOfDaySchema.nullable(),
    endTime: timeOfDaySchema.nullable(),
    timezone: timeZoneSchema,
    repeat: eventRepeatSchema.nullable().optional(),
    /** The whole event's reminder (one occurrence's change keeps it); null: none. */
    reminder: z.literal(calendarReminders).nullable().optional(),
    /** Home events: membership ids of current members. */
    participants: z.array(id).max(CALENDAR_LIMITS.participants).optional(),
    /** Personal events: the person's Homes to share it with. */
    shares: z.array(id).max(CALENDAR_LIMITS.shares).optional(),
  })
  .superRefine((event, context) => {
    if (event.allDay !== (event.startTime === null) || event.allDay !== (event.endTime === null)) {
      context.addIssue({ code: "custom", message: "time", path: ["startTime"] });
      return;
    }
    if (event.endsOn < event.startsOn) {
      context.addIssue({ code: "custom", message: "dateOrder", path: ["endsOn"] });
      return;
    }
    const days = daysBetween(event.startsOn, event.endsOn);
    if (event.allDay && days >= CALENDAR_LIMITS.allDayDays) {
      context.addIssue({ code: "custom", message: "tooLong", path: ["endsOn"] });
    }
    if (!event.allDay && event.startTime !== null && event.endTime !== null) {
      const start = `${event.startsOn}T${event.startTime}`;
      const end = `${event.endsOn}T${event.endTime}`;
      if (end <= start) {
        context.addIssue({ code: "custom", message: "dateOrder", path: ["endTime"] });
      } else if (
        days > CALENDAR_LIMITS.timedDays ||
        (days === CALENDAR_LIMITS.timedDays && event.endTime > event.startTime)
      ) {
        context.addIssue({ code: "custom", message: "tooLong", path: ["endsOn"] });
      }
    }
    const repeat = event.repeat;
    if (repeat) {
      if ((repeat.frequency === "weekly") !== (repeat.weekdays !== null)) {
        context.addIssue({ code: "custom", message: "invalid", path: ["repeat", "weekdays"] });
      } else if (
        repeat.weekdays !== null &&
        !repeat.weekdays.includes(isoWeekday(event.startsOn))
      ) {
        context.addIssue({ code: "custom", message: "startWeekday", path: ["repeat", "weekdays"] });
      }
      if (repeat.endsOn !== null && repeat.endsOn < event.startsOn) {
        context.addIssue({ code: "custom", message: "dateOrder", path: ["repeat", "endsOn"] });
      }
      if (repeat.endsOn !== null && repeat.count !== null) {
        context.addIssue({ code: "custom", message: "invalid", path: ["repeat", "count"] });
      }
    }
  });
export type EventFields = z.output<typeof eventFieldsSchema>;

export const eventScopes = ["only", "following", "all"] as const;
export type EventScope = (typeof eventScopes)[number];

export const createEventSchema = z.strictObject({
  id,
  homeId: id.nullable(),
  event: eventFieldsSchema,
});

export const updateEventSchema = z.strictObject({
  revision: z.int().min(1),
  scope: z.enum(eventScopes).nullable(),
  on: dateOnlySchema.nullable(),
  event: eventFieldsSchema,
  dryRun: z.boolean().optional(),
  /** The id of the new series that "this and following" starts (client-chosen, so retries match). */
  newId: id.optional(),
});

export const deleteEventSchema = z.strictObject({
  revision: z.int().min(1),
  scope: z.enum(eventScopes).nullable(),
  on: dateOnlySchema.nullable(),
  dryRun: z.boolean().optional(),
});

export const sharesSchema = z.strictObject({
  revision: z.int().min(1),
  homeIds: z
    .array(id)
    .max(CALENDAR_LIMITS.shares)
    .refine((ids) => new Set(ids).size === ids.length, "duplicate"),
});

export const calendarAccessSchema = z.strictObject({
  membershipId: id,
  level: z.enum(calendarMemberLevels),
});

/**
 * The person's own view settings for one calendar (`homeId` null: Personal). Only the values given
 * change. Vacations and chores belong to a Home's calendar.
 */
export const calendarPreferencesSchema = z
  .strictObject({
    homeId: id.nullable(),
    showVacations: z.boolean().optional(),
    showTasks: z.boolean().optional(),
    showChores: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.showVacations !== undefined ||
      input.showTasks !== undefined ||
      input.showChores !== undefined,
    "empty",
  )
  .refine(
    (input) =>
      input.homeId !== null ||
      (input.showVacations === undefined && input.showChores === undefined),
    "homeOnly",
  );
export type CalendarPreferences = z.input<typeof calendarPreferencesSchema>;

/** `GET /api/v1/calendar`: a context and a window of at most 62 local dates. */
export const windowQuerySchema = z
  .object({
    homeId: id.optional(),
    from: dateOnlySchema,
    to: dateOnlySchema,
  })
  .refine(
    (query) =>
      query.to >= query.from && daysBetween(query.from, query.to) < CALENDAR_LIMITS.windowDays,
    { message: "window", path: ["to"] },
  );

/** `GET /api/v1/calendar/events/:id`: the context and an occurrence date. */
export const eventQuerySchema = z.object({
  homeId: id.optional(),
  on: dateOnlySchema.optional(),
});

export const calendarViews = ["month", "week", "day", "agenda"] as const;
export type CalendarView = (typeof calendarViews)[number];

/** The calendar page's address: the view and a date in it. Anything else falls back to defaults. */
export const calendarPageQuerySchema = z.object({
  view: z.enum(calendarViews).catch("month"),
  date: dateOnlySchema.optional().catch(undefined),
});
export type CalendarPageQuery = z.output<typeof calendarPageQuerySchema>;

/** Upcoming events widget settings. */
export const upcomingDays = [7, 14, 30] as const;
export const upcomingCounts = [3, 5, 10] as const;
