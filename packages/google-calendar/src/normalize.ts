/**
 * Google's calendar list entries and events, reduced to what Madeora stores (S33), in the shape
 * `google_sync_calendars` and `google_sync_apply_events` take. Text is cut to Madeora's limits and
 * cleaned of control characters, so a Google value can never be refused by the database's checks; an
 * entry without an id or times is dropped. Pure.
 */
import { z } from "zod";

export const TEXT_LIMITS = { title: 200, location: 200, description: 4000, name: 200 } as const;

// Characters the database's plain-text check refuses (tests/db: private.is_plain_text).
// eslint-disable-next-line no-control-regex -- the point of the check is control characters
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** One line of text: control characters and line breaks become spaces, cut to `max`; blank → null. */
export function singleLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(CONTROL, " ")
    .replace(/[\t\r\n]+/g, " ")
    .trim();
  if (cleaned === "") return null;
  return Array.from(cleaned).slice(0, max).join("").trim() || null;
}

/** Plain text that may span lines, cut to `max`; blank → null. */
export function plainText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL, "").trim();
  if (cleaned === "") return null;
  return Array.from(cleaned).slice(0, max).join("").trim() || null;
}

const shortText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex -- the point of the check is control characters
    .refine((value) => !/[\u0000-\u001F\u007F]/.test(value));

const zone = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+/-]*$/);

export const accessRoles = ["freeBusyReader", "reader", "writer", "owner"] as const;

export interface NormalizedCalendar {
  readonly id: string;
  readonly name: string;
  readonly timeZone: string | null;
  readonly accessRole: (typeof accessRoles)[number];
  readonly primary: boolean;
}

const calendarEntry = z.object({
  id: shortText(1024),
  summary: z.string().optional(),
  summaryOverride: z.string().optional(),
  timeZone: z.string().optional(),
  accessRole: z.enum(accessRoles),
  primary: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

export function normalizeCalendar(raw: unknown): NormalizedCalendar | null {
  const parsed = calendarEntry.safeParse(raw);
  if (!parsed.success || parsed.data.deleted) return null;
  const entry = parsed.data;
  const name =
    singleLine(entry.summaryOverride, TEXT_LIMITS.name) ??
    singleLine(entry.summary, TEXT_LIMITS.name) ??
    singleLine(entry.id, TEXT_LIMITS.name) ??
    "Google";
  const timeZone = zone.safeParse(entry.timeZone);
  return {
    id: entry.id,
    name,
    timeZone: timeZone.success ? timeZone.data : null,
    accessRole: entry.accessRole,
    primary: entry.primary === true,
  };
}

export type NormalizedEvent =
  | { readonly id: string; readonly cancelled: true }
  | {
      readonly id: string;
      readonly etag: string | null;
      readonly updated: string | null;
      readonly status: "confirmed" | "tentative";
      readonly title: string | null;
      readonly location: string | null;
      readonly description: string | null;
      readonly allDay: boolean;
      readonly startsOn: string | null;
      readonly endsOn: string | null;
      readonly startsAt: string | null;
      readonly endsAt: string | null;
      readonly timeZone: string | null;
      readonly recurringEventId: string | null;
      readonly originalStart: string | null;
      readonly private: boolean;
      readonly link: string | null;
    };

const date = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
const when = z.object({
  date: date.optional(),
  dateTime: dateTime.optional(),
  timeZone: z.string().optional(),
});

const eventEntry = z.object({
  id: shortText(1024),
  status: z.string().optional(),
  etag: z.string().optional(),
  updated: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  visibility: z.string().optional(),
  htmlLink: z.string().optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: when.optional(),
  start: when.optional(),
  end: when.optional(),
});

const LINK = /^https:\/\/(www\.)?google\.com\/calendar\//;

function previousDay(day: string): string {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function optional(value: string | undefined, max: number): string | null {
  return value !== undefined && value.length > 0 && value.length <= max ? value : null;
}

/** A Google event (from events.list with singleEvents), or null when it cannot be stored. */
export function normalizeEvent(raw: unknown): NormalizedEvent | null {
  const parsed = eventEntry.safeParse(raw);
  if (!parsed.success) return null;
  const event = parsed.data;
  if (event.status === "cancelled") return { id: event.id, cancelled: true };
  const { start, end } = event;
  if (!start || !end) return null;
  let allDay: boolean;
  let startsOn: string | null = null;
  let endsOn: string | null = null;
  let startsAt: string | null = null;
  let endsAt: string | null = null;
  if (start.date && end.date) {
    allDay = true;
    startsOn = start.date;
    // Google's all-day end is exclusive; Madeora stores the last day.
    endsOn = end.date > start.date ? previousDay(end.date) : start.date;
  } else if (start.dateTime && end.dateTime) {
    allDay = false;
    const from = new Date(start.dateTime);
    const to = new Date(end.dateTime);
    startsAt = from.toISOString();
    endsAt = (to < from ? from : to).toISOString();
  } else {
    return null;
  }
  const timeZone = zone.safeParse(start.timeZone);
  const updated = dateTime.safeParse(event.updated);
  const original = event.originalStartTime?.dateTime ?? event.originalStartTime?.date;
  return {
    id: event.id,
    etag: optional(event.etag, 200),
    updated: updated.success ? updated.data : null,
    status: event.status === "tentative" ? "tentative" : "confirmed",
    title: singleLine(event.summary, TEXT_LIMITS.title),
    location: singleLine(event.location, TEXT_LIMITS.location),
    description: plainText(event.description, TEXT_LIMITS.description),
    allDay,
    startsOn,
    endsOn,
    startsAt,
    endsAt,
    timeZone: timeZone.success ? timeZone.data : null,
    recurringEventId: optional(event.recurringEventId, 1024),
    originalStart: optional(original, 64),
    private: event.visibility === "private" || event.visibility === "confidential",
    link:
      event.htmlLink && event.htmlLink.length <= 2048 && LINK.test(event.htmlLink)
        ? event.htmlLink
        : null,
  };
}
