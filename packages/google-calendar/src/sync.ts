/**
 * The inbound sync of one connection (S33, architecture.md §31), behind small ports so every rule is
 * unit-tested with fakes. The job `google-calendar-sync` (packages/jobs) runs it.
 *
 * A run takes the connection's lease in the database (one run at a time), opens the refresh token (bound
 * to the person), gets a fresh access token (memory only), applies Google's calendar list, then syncs each
 * chosen calendar:
 *   - incremental from its sync token; Google's 410 (the token is no longer valid) starts a full resync;
 *   - a full pass over the window (30 days back, 365 days ahead, recurring events expanded) when there is
 *     no token or the last full pass is over a day old; the database then removes what it did not see.
 * Every page is applied idempotently (upsert on calendar and Google id), so a retried run or a repeated
 * page never duplicates an event. Google refusing the refresh token ends the run as
 * `authorization_expired`: syncing stops and the person is asked to reconnect.
 */
import {
  GoogleAuthorizationError,
  GoogleClientError,
  GoogleHttpError,
  type GoogleCalendarClient,
} from "./client.ts";
import { SealError, openRefreshToken } from "./crypto.ts";
import type { NormalizedCalendar, NormalizedEvent } from "./normalize.ts";

export const SYNC_LIMITS = {
  eventsPerCalendar: 5000,
  pagesPerPass: 40,
  windowDaysBack: 30,
  windowDaysAhead: 365,
  leaseSeconds: 300,
} as const;

export type BeginResult =
  | { readonly outcome: "ok"; readonly userId: string; readonly token: string }
  | { readonly outcome: "missing" | "expired" | "inactive" | "busy" };

export interface SyncCalendar {
  readonly id: string;
  readonly googleId: string;
  readonly syncToken: string | null;
  readonly fullDue: boolean;
}

/** The database functions the run uses (service role, each rechecking the lease). */
export interface SyncStore {
  begin(connectionId: string, lease: string, leaseSeconds: number): Promise<BeginResult>;
  /** Null when the lease is no longer held. */
  applyCalendars(
    connectionId: string,
    lease: string,
    calendars: readonly NormalizedCalendar[],
  ): Promise<readonly SyncCalendar[] | null>;
  /** The calendar's stored event count afterwards; null when the lease is not held. */
  applyEvents(
    calendarId: string,
    lease: string,
    full: boolean,
    events: readonly NormalizedEvent[],
  ): Promise<number | null>;
  finishCalendar(
    calendarId: string,
    lease: string,
    full: boolean,
    syncToken: string | null,
    error: string | null,
  ): Promise<boolean>;
  finish(connectionId: string, lease: string, outcome: string): Promise<boolean>;
}

export interface SyncLogger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
}

export interface SyncDependencies {
  readonly store: SyncStore;
  readonly google: GoogleCalendarClient;
  readonly tokenKey: Buffer;
  readonly lease: string;
  readonly now: () => Date;
  readonly logger: SyncLogger;
}

export type SyncOutcome =
  | "synced"
  | "partial"
  | "authorization_expired"
  | "lease_lost"
  | "missing"
  | "expired"
  | "inactive"
  | "busy";

/** Google or the network failed before any calendar could sync: the job retries later. */
export class SyncRetryableError extends Error {
  constructor(readonly code: string) {
    super(`google calendar sync: ${code}`);
    this.name = "SyncRetryableError";
  }
}

/** The sync can never succeed as configured (Google refused the OAuth client). */
export class SyncPermanentError extends Error {
  constructor(readonly code: string) {
    super(`google calendar sync: ${code}`);
    this.name = "SyncPermanentError";
  }
}

class LeaseLost extends Error {}
class TooManyEvents extends Error {}
class TokenGone extends Error {}

/** The code stored on a calendar for an error, or null when the error is not the calendar's. */
function calendarErrorCode(error: unknown): string | null {
  if (error instanceof TooManyEvents) return "too_many_events";
  if (error instanceof GoogleHttpError) {
    if (error.retryable) return "google_unavailable";
    if (error.status === 404) return "calendar_not_found";
    if (error.status === 403) return "calendar_forbidden";
    return "google_refused";
  }
  return null;
}

export async function syncConnection(
  connectionId: string,
  dependencies: SyncDependencies,
): Promise<SyncOutcome> {
  const { store, google, tokenKey, lease, logger } = dependencies;
  const begun = await store.begin(connectionId, lease, SYNC_LIMITS.leaseSeconds);
  if (begun.outcome !== "ok") return begun.outcome;

  const expire = async (): Promise<SyncOutcome> => {
    await store.finish(connectionId, lease, "authorization_expired");
    return "authorization_expired";
  };

  let refreshToken: string;
  try {
    refreshToken = openRefreshToken(begun.token, tokenKey, begun.userId);
  } catch (error) {
    if (!(error instanceof SealError)) throw error;
    // Sealed with another key or for another person: unusable, so the person must reconnect.
    logger.warn("google_calendar.sync.token_unreadable");
    return expire();
  }

  let accessToken: string;
  let calendars: readonly NormalizedCalendar[];
  try {
    accessToken = await google.refreshAccessToken(refreshToken);
    calendars = await google.listCalendars(accessToken);
  } catch (error) {
    if (error instanceof GoogleAuthorizationError) return expire();
    if (error instanceof GoogleClientError) {
      await store.finish(connectionId, lease, "client_refused");
      throw new SyncPermanentError("client_refused");
    }
    if (error instanceof GoogleHttpError) {
      const code = error.retryable ? "google_unavailable" : "google_refused";
      await store.finish(connectionId, lease, code);
      if (error.retryable) throw new SyncRetryableError(code);
      return "partial";
    }
    throw error;
  }

  const chosen = await store.applyCalendars(connectionId, lease, calendars);
  if (chosen === null) return "lease_lost";

  const now = dependencies.now();
  const window = {
    timeMin: new Date(now.getTime() - SYNC_LIMITS.windowDaysBack * 86_400_000),
    timeMax: new Date(now.getTime() + SYNC_LIMITS.windowDaysAhead * 86_400_000),
  };

  async function pass(calendar: SyncCalendar, full: boolean): Promise<void> {
    let pageToken: string | null = null;
    for (let page = 0; page < SYNC_LIMITS.pagesPerPass; page += 1) {
      let result;
      try {
        result = await google.listEvents(accessToken, {
          calendarId: calendar.googleId,
          syncToken: full ? null : calendar.syncToken,
          pageToken,
          ...window,
        });
      } catch (error) {
        if (!full && error instanceof GoogleHttpError && error.status === 410)
          throw new TokenGone();
        throw error;
      }
      const count = await store.applyEvents(calendar.id, lease, full, result.items);
      if (count === null) throw new LeaseLost();
      if (count > SYNC_LIMITS.eventsPerCalendar) throw new TooManyEvents();
      pageToken = result.nextPageToken;
      if (!pageToken) {
        if (!result.nextSyncToken) throw new GoogleHttpError(200, "no_sync_token");
        if (!(await store.finishCalendar(calendar.id, lease, full, result.nextSyncToken, null))) {
          throw new LeaseLost();
        }
        return;
      }
    }
    throw new TooManyEvents();
  }

  let failures = 0;
  for (const calendar of chosen) {
    try {
      const full = calendar.fullDue || calendar.syncToken === null;
      try {
        await pass(calendar, full);
      } catch (error) {
        if (!(error instanceof TokenGone)) throw error;
        // 410: the sync token is no longer valid. Clear it, then resync the whole window.
        logger.info("google_calendar.sync.token_invalid");
        if (!(await store.finishCalendar(calendar.id, lease, false, null, "sync_token_invalid"))) {
          throw new LeaseLost();
        }
        await pass(calendar, true);
      }
    } catch (error) {
      if (error instanceof LeaseLost) return "lease_lost";
      if (error instanceof GoogleAuthorizationError) return expire();
      const code = calendarErrorCode(error);
      if (code === null) throw error;
      failures += 1;
      logger.warn("google_calendar.sync.calendar_failed", { code });
      if (!(await store.finishCalendar(calendar.id, lease, false, null, code))) return "lease_lost";
    }
  }

  if (!(await store.finish(connectionId, lease, "ok"))) return "lease_lost";
  return failures === 0 ? "synced" : "partial";
}
