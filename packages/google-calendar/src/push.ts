/**
 * Sending the person's changes to Google (S34, architecture.md §31, Modules.md §4.2). Runs inside the sync
 * run's lease, before the pull, behind small ports so every rule is unit-tested with a fake Google.
 *
 * Every write is conditional on the etag of the Google version the person changed (If-Match), so Madeora
 * never overwrites a newer Google version:
 *   - 412 (Google changed it): the current version is read and handed to the database, which merges fields
 *     changed on one side only or stores a conflict for the person to resolve (never this code);
 *   - 404/410 on an edit: "deleted in Google" (a conflict); on a deletion: done;
 *   - 401 / refused refresh: the run ends as authorization expired; the changes wait;
 *   - unreachable, 429, 5xx: the change waits for the next run; 400/403: it fails with a reason.
 * New events get the id Madeora chose, so a retried insert answers 409 and counts as done.
 * Series scopes: "all events" patches the series; "this and following" ends the old series just before the
 * occurrence and starts a new one there (refused for counted series); neither moves a series to other days.
 */
import {
  GoogleAuthorizationError,
  GoogleHttpError,
  type GoogleCalendarClient,
  type GoogleEventBody,
  type GoogleEventResource,
  type GoogleWhen,
  type WrittenEvent,
} from "./client.ts";
import type { NormalizedEvent } from "./normalize.ts";
import {
  SeriesLimitError,
  addDays,
  continueRecurrence,
  daysBetween,
  endRecurrence,
  instantOf,
  rruleFor,
  untilBefore,
  wallClock,
  type RepeatRule,
} from "./recurrence.ts";

export const changeFields = ["title", "location", "description", "time"] as const;
export type ChangeField = (typeof changeFields)[number];

/** An event version as the database stores it (normalizeEvent's shape, or a deletion). */
export interface Snapshot {
  readonly etag?: string | null;
  readonly deleted?: boolean;
  readonly title?: string | null;
  readonly location?: string | null;
  readonly description?: string | null;
  readonly allDay?: boolean;
  readonly startsOn?: string | null;
  readonly endsOn?: string | null;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly timeZone?: string | null;
  readonly originalStart?: string | null;
  readonly recurringEventId?: string | null;
}

export interface PushChange {
  readonly id: string;
  readonly version: number;
  readonly googleCalendarId: string;
  readonly calendarTimeZone: string | null;
  readonly action: "create" | "update" | "delete";
  readonly scope: "event" | "following" | "all";
  readonly googleEventId: string;
  readonly seriesId: string | null;
  readonly fields: readonly ChangeField[];
  readonly base: Snapshot | null;
  readonly mine: Snapshot | null;
  readonly repeat: RepeatRule | null;
}

/** An event Google still has (not a cancellation). */
export type GoogleVersion = Exclude<NormalizedEvent, { readonly cancelled: true }>;

export type PushResult =
  | { readonly outcome: "done"; readonly event: NormalizedEvent | null }
  | { readonly outcome: "changed"; readonly theirs: GoogleVersion | { readonly deleted: true } }
  | { readonly outcome: "failed"; readonly code: string }
  | { readonly outcome: "retry"; readonly code: string };

/** What the database answers after a result: still pending (another try in this run) or not. */
export type PushAnswer =
  | {
      readonly state: "pending";
      readonly version: number;
      readonly base: Snapshot;
      readonly mine: Snapshot | null;
      readonly fields: readonly ChangeField[];
      readonly action: "create" | "update" | "delete";
    }
  | { readonly state: string };

export interface PushStore {
  /** Null when the lease is no longer held. */
  pushChanges(connectionId: string, lease: string): Promise<readonly PushChange[] | null>;
  /** Null when the lease is no longer held. */
  pushResult(
    changeId: string,
    lease: string,
    version: number,
    result: PushResult,
  ): Promise<PushAnswer | null>;
}

export class PushLeaseLost extends Error {}

const TRIES_PER_CHANGE = 3;

/** Google's start and end for a version (local time plus zone for timed events). */
export function timeBody(
  version: Snapshot,
  fallbackZone: string | null,
): { start: GoogleWhen; end: GoogleWhen } {
  if (version.allDay) {
    const startsOn = version.startsOn ?? "";
    const endsOn = version.endsOn ?? startsOn;
    // Google's all-day end is exclusive.
    return { start: { date: startsOn }, end: { date: addDays(endsOn, 1) } };
  }
  const zone = version.timeZone ?? fallbackZone ?? "UTC";
  const start = Date.parse(version.startsAt ?? "");
  const end = Date.parse(version.endsAt ?? "");
  return {
    start: { dateTime: wallClock(start, zone), timeZone: zone },
    end: { dateTime: wallClock(end, zone), timeZone: zone },
  };
}

/** The body that writes `fields` of a version (cleared text is sent as empty, which Google clears). */
export function eventBody(
  version: Snapshot,
  fields: readonly ChangeField[],
  fallbackZone: string | null,
): GoogleEventBody {
  const body: { -readonly [K in keyof GoogleEventBody]: GoogleEventBody[K] } = {};
  if (fields.includes("title")) body.summary = version.title ?? "";
  if (fields.includes("location")) body.location = version.location ?? "";
  if (fields.includes("description")) body.description = version.description ?? "";
  if (fields.includes("time")) Object.assign(body, timeBody(version, fallbackZone));
  return body;
}

function localParts(when: GoogleWhen | null, fallbackZone: string): { date: string; zone: string } {
  if (when?.date) return { date: when.date, zone: when.timeZone ?? fallbackZone };
  const zone = when?.timeZone ?? fallbackZone;
  const instant = Date.parse(when?.dateTime ?? "");
  return { date: wallClock(instant, zone).slice(0, 10), zone };
}

/**
 * A series' new start and end on `date` with the time of day and length of `mine` (the changed occurrence).
 * Series scopes keep the date of each occurrence; only the time of day and the length change.
 */
export function seriesTime(
  date: string,
  mine: Snapshot,
  zone: string,
): { start: GoogleWhen; end: GoogleWhen } {
  if (mine.allDay) {
    const length = daysBetween(mine.startsOn ?? date, mine.endsOn ?? date);
    return { start: { date }, end: { date: addDays(date, length + 1) } };
  }
  const mineStart = Date.parse(mine.startsAt ?? "");
  const mineEnd = Date.parse(mine.endsAt ?? "");
  const time = wallClock(mineStart, zone).slice(11);
  const start = instantOf(`${date}T${time}`, zone) ?? mineStart;
  return {
    start: { dateTime: `${date}T${time}`, timeZone: zone },
    end: { dateTime: wallClock(start + (mineEnd - mineStart), zone), timeZone: zone },
  };
}

/** A series' own start and end as a snapshot (its time of day and length). */
function seriesSnapshot(series: GoogleEventResource): Snapshot {
  if (series.start?.date) {
    const startsOn = series.start.date;
    return {
      allDay: true,
      startsOn,
      endsOn: series.end?.date ? addDays(series.end.date, -1) : startsOn,
    };
  }
  return {
    allDay: false,
    startsAt: series.start?.dateTime ?? null,
    endsAt: series.end?.dateTime ?? null,
    timeZone: series.start?.timeZone ?? null,
  };
}

function theirsOf(found: WrittenEvent | null): GoogleVersion | { readonly deleted: true } {
  if (found === null || found.resource.status === "cancelled") return { deleted: true };
  // An answer Madeora cannot read is never taken for a deletion: the change waits for the next run.
  if (found.event === null) throw new GoogleHttpError(502, "unreadable");
  if ("cancelled" in found.event) return { deleted: true };
  return found.event;
}

function failureCode(error: GoogleHttpError): PushResult {
  if (error.retryable) return { outcome: "retry", code: "google_unavailable" };
  if (error.status === 403) return { outcome: "failed", code: "google_forbidden" };
  return { outcome: "failed", code: "google_refused" };
}

/** The new series' id for a split: derived from the change, so a retried insert answers 409. */
export function splitSeriesId(changeId: string): string {
  return `madeora${changeId.replace(/-/g, "").toLowerCase()}`;
}

export async function pushChange(
  google: GoogleCalendarClient,
  accessToken: string,
  change: PushChange,
): Promise<PushResult> {
  const calendar = change.googleCalendarId;
  const zone = change.mine?.timeZone ?? change.base?.timeZone ?? change.calendarTimeZone ?? "UTC";
  const base = change.base ?? {};
  const etag = base.etag ?? null;

  /** For series scopes: the occurrence the person acted on must still be the version they saw. */
  async function occurrenceChanged(): Promise<PushResult | null> {
    const found = await google.getEvent(accessToken, calendar, change.googleEventId);
    const theirs = theirsOf(found);
    if ("deleted" in theirs)
      return change.action === "delete" ? null : { outcome: "changed", theirs };
    if (theirs.etag !== etag) return { outcome: "changed", theirs };
    return null;
  }

  async function master(): Promise<GoogleEventResource | null> {
    const found = await google.getEvent(accessToken, calendar, change.seriesId ?? "");
    if (found === null || found.resource.status === "cancelled") return null;
    return found.resource;
  }

  try {
    if (change.scope === "event") {
      if (change.action === "create") {
        const mine = change.mine ?? {};
        const body: GoogleEventBody = {
          id: change.googleEventId,
          ...eventBody(mine, changeFields, change.calendarTimeZone),
          ...(change.repeat
            ? {
                recurrence: [
                  rruleFor(
                    change.repeat,
                    mine.allDay
                      ? (mine.startsOn ?? "")
                      : wallClock(Date.parse(mine.startsAt ?? ""), zone).slice(0, 10),
                    mine.allDay ? null : zone,
                  ),
                ],
              }
            : {}),
        };
        try {
          const created = await google.insertEvent(accessToken, calendar, body);
          return { outcome: "done", event: change.repeat ? null : created.event };
        } catch (error) {
          if (!(error instanceof GoogleHttpError) || error.status !== 409) throw error;
          // Inserted by an earlier try. A new series is done (its occurrences come with the pull); a single
          // event is weighed against what Google has, so an edit made since the earlier try is still sent.
          const found = await google.getEvent(accessToken, calendar, change.googleEventId);
          if (found === null) return { outcome: "failed", code: "google_refused" };
          if (change.repeat) return { outcome: "done", event: null };
          return { outcome: "changed", theirs: theirsOf(found) };
        }
      }
      if (change.action === "update") {
        const mine = change.mine ?? {};
        try {
          const restore = base.deleted === true;
          const body: GoogleEventBody = {
            ...eventBody(mine, restore ? changeFields : change.fields, change.calendarTimeZone),
            ...(restore ? { status: "confirmed" as const } : {}),
          };
          const saved = await google.patchEvent(
            accessToken,
            calendar,
            change.googleEventId,
            body,
            restore ? null : etag,
          );
          return { outcome: "done", event: saved.event };
        } catch (error) {
          if (!(error instanceof GoogleHttpError)) throw error;
          if (error.status === 412) {
            const found = await google.getEvent(accessToken, calendar, change.googleEventId);
            return { outcome: "changed", theirs: theirsOf(found) };
          }
          if (error.status === 404 || error.status === 410) {
            return { outcome: "changed", theirs: { deleted: true } };
          }
          throw error;
        }
      }
      try {
        await google.deleteEvent(accessToken, calendar, change.googleEventId, etag);
        return { outcome: "done", event: null };
      } catch (error) {
        if (!(error instanceof GoogleHttpError)) throw error;
        if (error.status === 404 || error.status === 410) return { outcome: "done", event: null };
        if (error.status === 412) {
          const found = await google.getEvent(accessToken, calendar, change.googleEventId);
          return { outcome: "changed", theirs: theirsOf(found) };
        }
        throw error;
      }
    }

    // A series scope.
    const changed = await occurrenceChanged();
    if (changed) return changed;
    const series = await master();
    if (series === null) {
      return change.action === "delete"
        ? { outcome: "done", event: null }
        : { outcome: "changed", theirs: { deleted: true } };
    }
    const seriesZone = series.start?.timeZone ?? zone;

    if (change.action === "delete" && change.scope === "all") {
      try {
        await google.deleteEvent(accessToken, calendar, series.id, series.etag);
      } catch (error) {
        if (!(error instanceof GoogleHttpError)) throw error;
        if (error.status !== 404 && error.status !== 410) throw error;
      }
      return { outcome: "done", event: null };
    }

    const originalStart = base.originalStart ?? base.startsOn ?? base.startsAt ?? "";
    if (change.action === "delete") {
      await google.patchEvent(
        accessToken,
        calendar,
        series.id,
        { recurrence: endRecurrence(series.recurrence, untilBefore(originalStart)) },
        series.etag,
      );
      return { outcome: "done", event: null };
    }

    const mine = change.mine ?? {};
    const text = eventBody(
      mine,
      change.fields.filter((field) => field !== "time"),
      change.calendarTimeZone,
    );

    if (change.scope === "all") {
      const startDate = localParts(series.start, seriesZone).date;
      await google.patchEvent(
        accessToken,
        calendar,
        series.id,
        {
          ...text,
          ...(change.fields.includes("time") ? seriesTime(startDate, mine, seriesZone) : {}),
        },
        series.etag,
      );
      return { outcome: "done", event: null };
    }

    // This and following: a new series from this occurrence, then the old one ends just before it.
    const recurrence = continueRecurrence(series.recurrence);
    const occurrenceDate = /^\d{4}-\d{2}-\d{2}$/.test(originalStart)
      ? originalStart
      : wallClock(Date.parse(originalStart), seriesZone).slice(0, 10);
    // Without a time change the new series keeps the series' own time (not a moved occurrence's).
    const startEnd = change.fields.includes("time")
      ? seriesTime(occurrenceDate, mine, seriesZone)
      : seriesTime(occurrenceDate, seriesSnapshot(series), seriesZone);
    const fresh: GoogleEventBody = {
      id: splitSeriesId(change.id),
      summary: series.summary ?? "",
      ...(series.location ? { location: series.location } : {}),
      ...(series.description ? { description: series.description } : {}),
      ...(series.visibility ? { visibility: series.visibility } : {}),
      ...(series.transparency ? { transparency: series.transparency } : {}),
      ...(series.colorId ? { colorId: series.colorId } : {}),
      ...text,
      ...startEnd,
      recurrence,
    };
    try {
      await google.insertEvent(accessToken, calendar, fresh);
    } catch (error) {
      if (!(error instanceof GoogleHttpError) || error.status !== 409) throw error;
    }
    try {
      if (occurrenceDate <= localParts(series.start, seriesZone).date) {
        // Split at the first occurrence: the new series replaces the whole old one.
        await google.deleteEvent(accessToken, calendar, series.id, series.etag);
      } else {
        await google.patchEvent(
          accessToken,
          calendar,
          series.id,
          { recurrence: endRecurrence(series.recurrence, untilBefore(originalStart)) },
          series.etag,
        );
      }
    } catch (error) {
      // The old series changed meanwhile (412): the next run inserts again (409) and ends it then. Any
      // other refusal takes the new series back out, so Google never keeps both.
      if (error instanceof GoogleHttpError && error.status !== 412) {
        try {
          await google.deleteEvent(accessToken, calendar, fresh.id ?? "", null);
        } catch {
          // Best effort; the failure below is what the person sees.
        }
      }
      throw error;
    }
    return { outcome: "done", event: null };
  } catch (error) {
    if (error instanceof GoogleAuthorizationError) throw error;
    if (error instanceof SeriesLimitError) return { outcome: "failed", code: "series_limit" };
    if (error instanceof GoogleHttpError) {
      // The series itself changed between reading and writing it: try again in the next run.
      if (error.status === 412) return { outcome: "retry", code: "google_changed" };
      return failureCode(error);
    }
    throw error;
  }
}

/**
 * Sends every waiting change of the connection. A change the database rebased on a newer Google version
 * (fields changed on one side only) is tried again, up to three times in one run. Throws
 * GoogleAuthorizationError (the run ends as authorization expired) and PushLeaseLost.
 */
export async function pushChanges(
  store: PushStore,
  google: GoogleCalendarClient,
  accessToken: string,
  connectionId: string,
  lease: string,
): Promise<{ readonly sent: number; readonly waiting: number }> {
  const changes = await store.pushChanges(connectionId, lease);
  if (changes === null) throw new PushLeaseLost();
  let sent = 0;
  let waiting = 0;
  for (const first of changes) {
    let change: PushChange = first;
    for (let attempt = 0; attempt < TRIES_PER_CHANGE; attempt += 1) {
      const result = await pushChange(google, accessToken, change);
      const answer = await store.pushResult(change.id, lease, change.version, result);
      if (answer === null) throw new PushLeaseLost();
      if (answer.state === "done") sent += 1;
      if (answer.state === "waiting") waiting += 1;
      if (answer.state !== "pending" || !("base" in answer)) break;
      change = {
        ...change,
        version: answer.version,
        base: answer.base,
        mine: answer.mine,
        fields: answer.fields,
        action: answer.action,
      };
    }
  }
  return { sent, waiting };
}
