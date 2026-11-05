import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GoogleAuthorizationError,
  GoogleClientError,
  GoogleHttpError,
  type EventPage,
  type EventPageRequest,
  type GoogleCalendarClient,
  type GoogleEventBody,
  type WrittenEvent,
} from "./client.ts";
import type { PushChange, PushResult } from "./push.ts";
import { sealRefreshToken } from "./crypto.ts";
import type { NormalizedCalendar, NormalizedEvent } from "./normalize.ts";
import {
  SyncPermanentError,
  SyncRetryableError,
  syncConnection,
  type BeginResult,
  type SyncCalendar,
  type SyncStore,
} from "./sync.ts";

const key = randomBytes(32);
const userId = "10000000-0000-4000-8000-000000000001";
const CONNECTION = "conn-1";

interface StoredCalendar {
  syncEnabled: boolean;
  syncToken: string | null;
  fullDue: boolean;
  error: string | null;
  events: Map<string, { event: NormalizedEvent; seenIn: string | null }>;
}

/** The database's sync functions, in memory, with the same rules. */
class FakeStore implements SyncStore {
  lease: string | null = null;
  status: "connected" | "authorization_expired" = "connected";
  finished: string[] = [];
  calendars = new Map<string, StoredCalendar>();
  listed: NormalizedCalendar[] = [];
  token = sealRefreshToken("refresh-1", key, userId);
  loseLeaseAfterPages = Infinity;
  pages = 0;

  begin(_id: string, lease: string): Promise<BeginResult> {
    if (this.status !== "connected") return Promise.resolve({ outcome: "expired" });
    if (this.lease !== null && this.lease !== lease) return Promise.resolve({ outcome: "busy" });
    this.lease = lease;
    return Promise.resolve({ outcome: "ok", userId, token: this.token });
  }

  applyCalendars(_id: string, lease: string, calendars: readonly NormalizedCalendar[]) {
    if (lease !== this.lease) return Promise.resolve(null);
    this.listed = [...calendars];
    for (const calendar of calendars) {
      if (!this.calendars.has(calendar.id)) {
        this.calendars.set(calendar.id, {
          syncEnabled: calendar.primary,
          syncToken: null,
          fullDue: true,
          error: null,
          events: new Map(),
        });
      }
    }
    const chosen: SyncCalendar[] = [];
    for (const [id, calendar] of this.calendars) {
      if (calendar.syncEnabled && calendars.some((c) => c.id === id)) {
        chosen.push({
          id,
          googleId: id,
          syncToken: calendar.syncToken,
          fullDue: calendar.fullDue || calendar.syncToken === null,
        });
      }
    }
    return Promise.resolve(chosen);
  }

  applyEvents(
    calendarId: string,
    lease: string,
    full: boolean,
    events: readonly NormalizedEvent[],
  ) {
    this.pages += 1;
    if (lease !== this.lease || this.pages > this.loseLeaseAfterPages) {
      return Promise.resolve(null);
    }
    const calendar = this.calendars.get(calendarId);
    if (!calendar) return Promise.resolve(null);
    for (const event of events) {
      if ("cancelled" in event) {
        for (const [id, stored] of calendar.events) {
          if (
            id === event.id ||
            ("recurringEventId" in stored.event && stored.event.recurringEventId === event.id)
          ) {
            calendar.events.delete(id);
          }
        }
      } else {
        const previous = calendar.events.get(event.id);
        calendar.events.set(event.id, {
          event,
          seenIn: full ? lease : (previous?.seenIn ?? null),
        });
      }
    }
    return Promise.resolve(calendar.events.size);
  }

  finishCalendar(
    calendarId: string,
    lease: string,
    full: boolean,
    syncToken: string | null,
    error: string | null,
  ) {
    if (lease !== this.lease) return Promise.resolve(false);
    const calendar = this.calendars.get(calendarId);
    if (!calendar) return Promise.resolve(false);
    if (error) {
      calendar.error = error;
      if (error === "sync_token_invalid") calendar.syncToken = null;
      return Promise.resolve(true);
    }
    if (full) {
      for (const [id, stored] of calendar.events) {
        if (stored.seenIn !== lease) calendar.events.delete(id);
      }
      calendar.fullDue = false;
    }
    calendar.syncToken = syncToken;
    calendar.error = null;
    return Promise.resolve(true);
  }

  finish(_id: string, lease: string, outcome: string) {
    if (lease !== this.lease) return Promise.resolve(false);
    this.finished.push(outcome);
    if (outcome === "authorization_expired") this.status = "authorization_expired";
    this.lease = null;
    return Promise.resolve(true);
  }

  // Changes waiting for Google (push.test.ts covers sending them): none here unless a test adds one.
  pending: PushChange[] = [];
  results: PushResult[] = [];
  pushChanges(_id: string, lease: string) {
    if (lease !== this.lease) return Promise.resolve(null);
    return Promise.resolve(this.pending);
  }
  pushResult(_change: string, lease: string, _version: number, result: PushResult) {
    if (lease !== this.lease) return Promise.resolve(null);
    this.results.push(result);
    return Promise.resolve({ state: result.outcome === "done" ? "done" : "waiting" });
  }

  titles(calendarId: string): string[] {
    return [...(this.calendars.get(calendarId)?.events.values() ?? [])]
      .map(({ event }) => ("title" in event ? (event.title ?? "") : ""))
      .sort();
  }
}

type StoredEvent = Extract<NormalizedEvent, { status: string }>;

const event = (id: string, title: string, extra: Partial<StoredEvent> = {}): StoredEvent => ({
  id,
  etag: `"${id}"`,
  updated: null,
  status: "confirmed",
  title,
  location: null,
  description: null,
  allDay: true,
  startsOn: "2026-12-01",
  endsOn: "2026-12-01",
  startsAt: null,
  endsAt: null,
  timeZone: null,
  recurringEventId: null,
  originalStart: null,
  private: false,
  link: null,
  ...extra,
});

type Lister = (request: EventPageRequest) => EventPage | Error;

class FakeGoogle implements GoogleCalendarClient {
  refreshError: Error | null = null;
  listError: Error | null = null;
  calendars: NormalizedCalendar[] = [
    {
      id: "primary@gmail.com",
      name: "Primary",
      timeZone: "Europe/Brussels",
      accessRole: "owner",
      primary: true,
    },
  ];
  requests: EventPageRequest[] = [];
  lister: Lister = () => ({ items: [], nextPageToken: null, nextSyncToken: "s" });

  authorizationUrl(): string {
    return "";
  }
  exchangeCode(): never {
    throw new Error("unused");
  }
  refreshAccessToken(refreshToken: string) {
    if (this.refreshError) return Promise.reject(this.refreshError);
    expect(refreshToken).toBe("refresh-1");
    return Promise.resolve("access-1");
  }
  revoke() {
    return Promise.resolve(true);
  }
  primaryCalendarId() {
    return Promise.resolve("primary@gmail.com");
  }
  listCalendars() {
    if (this.listError) return Promise.reject(this.listError);
    return Promise.resolve(this.calendars);
  }
  listEvents(_access: string, request: EventPageRequest) {
    this.requests.push(request);
    const answer = this.lister(request);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }
  writes: string[] = [];
  writeError: Error | null = null;
  getEvent() {
    return Promise.resolve(null);
  }
  insertEvent(_access: string, _calendar: string, body: GoogleEventBody): Promise<WrittenEvent> {
    this.writes.push(`insert ${body.id ?? ""}`);
    if (this.writeError) return Promise.reject(this.writeError);
    return Promise.resolve({
      event: null,
      resource: {
        id: body.id ?? "",
        etag: '"1"',
        status: "confirmed",
        summary: null,
        location: null,
        description: null,
        visibility: null,
        transparency: null,
        colorId: null,
        start: null,
        end: null,
        recurrence: [],
      },
    });
  }
  patchEvent(): Promise<WrittenEvent> {
    return Promise.reject(new Error("unused"));
  }
  deleteEvent() {
    return Promise.resolve();
  }
}

const logger = { info: () => undefined, warn: () => undefined };
const now = () => new Date("2026-11-05T08:00:00Z");

function run(store: FakeStore, google: FakeGoogle, lease = "lease-1") {
  return syncConnection(CONNECTION, { store, google, tokenKey: key, lease, now, logger });
}

describe("google calendar sync", () => {
  it("does a full pass first, over the window, and stores the sync token", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    google.lister = (request) =>
      request.pageToken === null
        ? { items: [event("a", "A")], nextPageToken: "p2", nextSyncToken: null }
        : { items: [event("b", "B")], nextPageToken: null, nextSyncToken: "sync-1" };
    await expect(run(store, google)).resolves.toBe("synced");
    expect(store.titles("primary@gmail.com")).toEqual(["A", "B"]);
    expect(store.calendars.get("primary@gmail.com")?.syncToken).toBe("sync-1");
    expect(google.requests[0]).toMatchObject({ syncToken: null, pageToken: null });
    expect(google.requests[0]?.timeMin.toISOString()).toBe("2026-10-06T08:00:00.000Z");
    expect(google.requests[0]?.timeMax.toISOString()).toBe("2027-11-05T08:00:00.000Z");
    expect(store.finished).toEqual(["ok"]);
  });

  it("then syncs incrementally from the token: changes and cancellations, no duplicates", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    google.lister = () => ({
      items: [
        event("a", "A"),
        event("s_1", "Yoga", { recurringEventId: "s" }),
        event("s_2", "Yoga", { recurringEventId: "s" }),
      ],
      nextPageToken: null,
      nextSyncToken: "sync-1",
    });
    await run(store, google);
    google.lister = (request) => {
      expect(request.syncToken).toBe("sync-1");
      return {
        items: [event("a", "A2"), event("a", "A2"), { id: "s", cancelled: true }],
        nextPageToken: null,
        nextSyncToken: "sync-2",
      };
    };
    await expect(run(store, google, "lease-2")).resolves.toBe("synced");
    expect(store.titles("primary@gmail.com")).toEqual(["A2"]);
    expect(store.calendars.get("primary@gmail.com")?.syncToken).toBe("sync-2");
  });

  it("repeating the same run changes nothing (duplicate prevention)", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    google.lister = () => ({
      items: [event("a", "A"), event("b", "B")],
      nextPageToken: null,
      nextSyncToken: "s",
    });
    await run(store, google, "lease-1");
    const primary = store.calendars.get("primary@gmail.com");
    if (primary) primary.fullDue = true;
    await run(store, google, "lease-2");
    await run(store, google, "lease-3");
    expect(store.titles("primary@gmail.com")).toEqual(["A", "B"]);
  });

  it("resyncs the whole window when Google says the sync token is no longer valid (410)", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    google.lister = () => ({
      items: [event("a", "A"), event("gone", "Gone")],
      nextPageToken: null,
      nextSyncToken: "old",
    });
    await run(store, google);
    google.lister = (request) =>
      request.syncToken === "old"
        ? new GoogleHttpError(410, "fullSyncRequired")
        : { items: [event("a", "A")], nextPageToken: null, nextSyncToken: "fresh" };
    await expect(run(store, google, "lease-2")).resolves.toBe("synced");
    const calendar = store.calendars.get("primary@gmail.com");
    expect(calendar?.syncToken).toBe("fresh");
    expect(calendar?.error).toBeNull();
    expect(store.titles("primary@gmail.com")).toEqual(["A"]);
    expect(google.requests.slice(-2).map((r) => r.syncToken)).toEqual(["old", null]);
  });

  it("ends as authorization expired when Google refuses the refresh token (revoked consent)", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    google.lister = () => ({ items: [event("a", "A")], nextPageToken: null, nextSyncToken: "s" });
    await run(store, google);
    google.refreshError = new GoogleAuthorizationError("invalid_grant");
    await expect(run(store, google, "lease-2")).resolves.toBe("authorization_expired");
    expect(store.finished).toEqual(["ok", "authorization_expired"]);
    expect(store.titles("primary@gmail.com")).toEqual(["A"]);
    await expect(run(store, google, "lease-3")).resolves.toBe("expired");
  });

  it("ends as authorization expired when an API call is refused mid-run", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    google.lister = () => new GoogleAuthorizationError("unauthorized");
    await expect(run(store, google)).resolves.toBe("authorization_expired");
  });

  it("asks for a reconnect when the stored token cannot be opened", async () => {
    const store = new FakeStore();
    store.token = sealRefreshToken("refresh-1", randomBytes(32), userId);
    await expect(run(store, new FakeGoogle())).resolves.toBe("authorization_expired");
  });

  it("retries later when Google cannot be reached before any calendar synced", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    google.refreshError = new GoogleHttpError(0, null);
    await expect(run(store, google)).rejects.toBeInstanceOf(SyncRetryableError);
    expect(store.finished).toEqual(["google_unavailable"]);
    expect(store.lease).toBeNull();
  });

  it("stops for good when Google refuses the OAuth client", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    google.refreshError = new GoogleClientError("invalid_client");
    await expect(run(store, google)).rejects.toBeInstanceOf(SyncPermanentError);
  });

  it("records a calendar's own failure and goes on with the others", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    google.calendars = [
      { id: "primary@gmail.com", name: "P", timeZone: null, accessRole: "owner", primary: true },
      { id: "other", name: "O", timeZone: null, accessRole: "reader", primary: false },
    ];
    await run(store, google);
    const other = store.calendars.get("other");
    if (other) other.syncEnabled = true;
    google.lister = (request) =>
      request.calendarId === "primary@gmail.com"
        ? new GoogleHttpError(404, "notFound")
        : { items: [event("o", "O")], nextPageToken: null, nextSyncToken: "o" };
    await expect(run(store, google, "lease-2")).resolves.toBe("partial");
    expect(store.calendars.get("primary@gmail.com")?.error).toBe("calendar_not_found");
    expect(store.titles("other")).toEqual(["O"]);
  });

  it("fails a calendar with too many events instead of storing them all", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    let n = 0;
    google.lister = () => {
      const items = Array.from({ length: 250 }, () => event(`e${String((n += 1))}`, "x"));
      return { items, nextPageToken: "more", nextSyncToken: null };
    };
    await expect(run(store, google)).resolves.toBe("partial");
    expect(store.calendars.get("primary@gmail.com")?.error).toBe("too_many_events");
    expect(store.calendars.get("primary@gmail.com")?.syncToken).toBeNull();
  });

  it("stops at once when the lease is lost", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    store.loseLeaseAfterPages = 0;
    google.lister = () => ({ items: [event("a", "A")], nextPageToken: null, nextSyncToken: "s" });
    await expect(run(store, google)).resolves.toBe("lease_lost");
    expect(store.finished).toEqual([]);
  });

  it("does nothing while another run holds the connection", async () => {
    const store = new FakeStore();
    store.lease = "other-run";
    await expect(run(store, new FakeGoogle())).resolves.toBe("busy");
  });

  it("sends waiting changes before reading Google", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    store.pending = [
      {
        id: "10000000-0000-4000-8000-0000000000c1",
        version: 1,
        googleCalendarId: "primary@gmail.com",
        calendarTimeZone: "Europe/Brussels",
        action: "create",
        scope: "event",
        googleEventId: "madeoraabc",
        seriesId: null,
        fields: ["title", "location", "description", "time"],
        base: null,
        mine: { title: "New", allDay: true, startsOn: "2026-12-01", endsOn: "2026-12-01" },
        repeat: null,
      },
    ];
    google.lister = () => {
      google.writes.push("list");
      return { items: [], nextPageToken: null, nextSyncToken: "s" };
    };
    await expect(run(store, google)).resolves.toBe("synced");
    expect(google.writes).toEqual(["insert madeoraabc", "list"]);
    expect(store.results[0]?.outcome).toBe("done");
  });

  it("ends as authorization expired when Google refuses a change's token, keeping the change", async () => {
    const store = new FakeStore();
    const google = new FakeGoogle();
    store.pending = [
      {
        id: "10000000-0000-4000-8000-0000000000c2",
        version: 1,
        googleCalendarId: "primary@gmail.com",
        calendarTimeZone: null,
        action: "create",
        scope: "event",
        googleEventId: "madeoradef",
        seriesId: null,
        fields: ["title", "location", "description", "time"],
        base: null,
        mine: { title: "New", allDay: true, startsOn: "2026-12-01", endsOn: "2026-12-01" },
        repeat: null,
      },
    ];
    google.writeError = new GoogleAuthorizationError("unauthorized");
    await expect(run(store, google)).resolves.toBe("authorization_expired");
    expect(store.results).toEqual([]);
    expect(store.finished).toEqual(["authorization_expired"]);
  });
});
