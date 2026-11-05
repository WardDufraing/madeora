import { describe, expect, it } from "vitest";

import {
  GoogleAuthorizationError,
  GoogleHttpError,
  type GoogleCalendarClient,
  type GoogleEventBody,
  type GoogleEventResource,
  type WrittenEvent,
} from "./client.ts";
import { normalizeEvent } from "./normalize.ts";
import {
  pushChange,
  pushChanges,
  seriesTime,
  splitSeriesId,
  timeBody,
  type PushAnswer,
  type PushChange,
  type PushResult,
  type PushStore,
} from "./push.ts";

type Stored = Record<string, unknown> & { id: string; etag: string };

/** Google's events in memory, with etags, If-Match, ids that cannot repeat and scripted failures. */
class FakeGoogle implements GoogleCalendarClient {
  events = new Map<string, Stored>();
  calls: string[] = [];
  failNext: Error | null = null;
  bodies: GoogleEventBody[] = [];
  private version = 1;

  put(event: Record<string, unknown> & { id: string }): Stored {
    this.version += 1;
    const stored = { ...event, etag: `"v${String(this.version)}"` };
    this.events.set(event.id, stored);
    return stored;
  }

  private answer(stored: Stored): WrittenEvent {
    const resource: GoogleEventResource = {
      id: stored.id,
      etag: stored.etag,
      status: (stored.status as string | undefined) ?? "confirmed",
      summary: (stored.summary as string | undefined) ?? null,
      location: null,
      description: null,
      visibility: null,
      transparency: null,
      colorId: null,
      start: (stored.start as GoogleEventResource["start"]) ?? null,
      end: (stored.end as GoogleEventResource["end"]) ?? null,
      recurrence: (stored.recurrence as string[] | undefined) ?? [],
    };
    return { event: normalizeEvent(stored), resource };
  }

  private fail(): Error | null {
    const error = this.failNext;
    this.failNext = null;
    return error;
  }

  authorizationUrl(): string {
    return "";
  }
  exchangeCode(): never {
    throw new Error("unused");
  }
  refreshAccessToken() {
    return Promise.resolve("access");
  }
  revoke() {
    return Promise.resolve(true);
  }
  primaryCalendarId() {
    return Promise.resolve("primary");
  }
  listCalendars() {
    return Promise.resolve([]);
  }
  listEvents(): never {
    throw new Error("unused");
  }
  getEvent(_access: string, _calendar: string, id: string) {
    this.calls.push(`get ${id}`);
    const stored = this.events.get(id);
    return Promise.resolve(stored ? this.answer(stored) : null);
  }
  insertEvent(_access: string, _calendar: string, body: GoogleEventBody) {
    this.calls.push(`insert ${body.id ?? ""}`);
    this.bodies.push(body);
    const failure = this.fail();
    if (failure) return Promise.reject(failure);
    if (body.id && this.events.has(body.id))
      return Promise.reject(new GoogleHttpError(409, "duplicate"));
    return Promise.resolve(this.answer(this.put({ ...body, id: body.id ?? "generated" })));
  }
  patchEvent(
    _access: string,
    _calendar: string,
    id: string,
    body: GoogleEventBody,
    etag: string | null,
  ) {
    this.calls.push(`patch ${id}${etag ? ` if ${etag}` : ""}`);
    this.bodies.push(body);
    const failure = this.fail();
    if (failure) return Promise.reject(failure);
    const stored = this.events.get(id);
    if (!stored) return Promise.reject(new GoogleHttpError(404, "notFound"));
    if (etag && stored.etag !== etag)
      return Promise.reject(new GoogleHttpError(412, "conditionNotMet"));
    return Promise.resolve(this.answer(this.put({ ...stored, ...body, id })));
  }
  deleteEvent(_access: string, _calendar: string, id: string, etag: string | null) {
    this.calls.push(`delete ${id}${etag ? ` if ${etag}` : ""}`);
    const failure = this.fail();
    if (failure) return Promise.reject(failure);
    const stored = this.events.get(id);
    if (!stored) return Promise.reject(new GoogleHttpError(410, "deleted"));
    if (etag && stored.etag !== etag)
      return Promise.reject(new GoogleHttpError(412, "conditionNotMet"));
    this.events.delete(id);
    return Promise.resolve();
  }
}

const timed = (id: string, summary: string, start: string, end: string, extra = {}) => ({
  id,
  status: "confirmed",
  summary,
  start: { dateTime: start, timeZone: "Europe/Brussels" },
  end: { dateTime: end, timeZone: "Europe/Brussels" },
  ...extra,
});

const change = (extra: Partial<PushChange>): PushChange => ({
  id: "10000000-0000-4000-8000-0000000000aa",
  version: 1,
  googleCalendarId: "primary",
  calendarTimeZone: "Europe/Brussels",
  action: "update",
  scope: "event",
  googleEventId: "e1",
  seriesId: null,
  fields: ["title"],
  base: null,
  mine: null,
  repeat: null,
  ...extra,
});

const mineTimed = (title: string, startsAt: string, endsAt: string) => ({
  title,
  allDay: false,
  startsAt,
  endsAt,
  timeZone: "Europe/Brussels",
});

describe("Google bodies", () => {
  it("sends timed events as local wall-clock time plus the zone", () => {
    expect(timeBody(mineTimed("x", "2026-07-01T07:00:00Z", "2026-07-01T08:00:00Z"), null)).toEqual({
      start: { dateTime: "2026-07-01T09:00:00", timeZone: "Europe/Brussels" },
      end: { dateTime: "2026-07-01T10:00:00", timeZone: "Europe/Brussels" },
    });
  });

  it("sends all-day events with Google's exclusive end", () => {
    expect(timeBody({ allDay: true, startsOn: "2026-12-24", endsOn: "2026-12-26" }, null)).toEqual({
      start: { date: "2026-12-24" },
      end: { date: "2026-12-27" },
    });
  });

  it("moves a series to a new time of day on its own date, across DST", () => {
    // The occurrence changed in summer to 10:00–11:30; the series starts on a winter date.
    expect(
      seriesTime(
        "2026-11-02",
        mineTimed("x", "2026-07-06T08:00:00Z", "2026-07-06T09:30:00Z"),
        "Europe/Brussels",
      ),
    ).toEqual({
      start: { dateTime: "2026-11-02T10:00:00", timeZone: "Europe/Brussels" },
      end: { dateTime: "2026-11-02T11:30:00", timeZone: "Europe/Brussels" },
    });
  });
});

describe("sending one change", () => {
  it("creates an event with the id Madeora chose; a retry after a lost answer hands back Google's copy", async () => {
    const google = new FakeGoogle();
    const create = change({
      action: "create",
      googleEventId: "madeora1",
      fields: ["title", "location", "description", "time"],
      mine: mineTimed("Dentist", "2026-12-01T08:00:00Z", "2026-12-01T09:00:00Z"),
    });
    const first = await pushChange(google, "a", create);
    expect(first.outcome).toBe("done");
    expect(google.bodies[0]).toMatchObject({
      id: "madeora1",
      summary: "Dentist",
      start: { dateTime: "2026-12-01T09:00:00", timeZone: "Europe/Brussels" },
    });
    // Inserted by the first try: Google's copy goes back to the database, which ends the change or sends an
    // edit made since as an update.
    // An answer Madeora cannot read (here the fake's offset-less copy) is never taken for a deletion.
    expect(await pushChange(google, "a", create)).toEqual({
      outcome: "retry",
      code: "google_unavailable",
    });
    google.put({
      ...timed("madeora1", "Dentist", "2026-12-01T09:00:00+01:00", "2026-12-01T10:00:00+01:00"),
    });
    const again = await pushChange(google, "a", create);
    expect(again).toMatchObject({ outcome: "changed", theirs: { title: "Dentist" } });
    expect(google.calls).toEqual([
      "insert madeora1",
      "insert madeora1",
      "get madeora1",
      "insert madeora1",
      "get madeora1",
    ]);
    expect(google.events.size).toBe(1);
  });

  it("creates a repeating event with its RRULE; its occurrences come with the pull", async () => {
    const google = new FakeGoogle();
    const result = await pushChange(
      google,
      "a",
      change({
        action: "create",
        googleEventId: "madeora2",
        fields: ["title", "location", "description", "time"],
        mine: mineTimed("Swim", "2026-12-07T17:00:00Z", "2026-12-07T18:00:00Z"),
        repeat: { frequency: "weekly", interval: 1, weekdays: [1], endsOn: null, count: 10 },
      }),
    );
    expect(result).toEqual({ outcome: "done", event: null });
    expect(google.bodies[0]?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10"]);
  });

  it("edits with the etag of the version the person saw", async () => {
    const google = new FakeGoogle();
    const stored = google.put(
      timed("e1", "Old", "2026-12-01T09:00:00+01:00", "2026-12-01T10:00:00+01:00"),
    );
    const result = await pushChange(
      google,
      "a",
      change({ base: { etag: stored.etag }, mine: { title: "New" }, fields: ["title"] }),
    );
    expect(result).toMatchObject({ outcome: "done", event: { title: "New" } });
    expect(google.calls).toEqual([`patch e1 if ${stored.etag}`]);
    expect(google.bodies[0]).toEqual({ summary: "New" });
  });

  it("hands Google's newer version back instead of overwriting it (412)", async () => {
    const google = new FakeGoogle();
    google.put(timed("e1", "Old", "2026-12-01T09:00:00+01:00", "2026-12-01T10:00:00+01:00"));
    google.put(
      timed("e1", "Changed in Google", "2026-12-01T09:00:00+01:00", "2026-12-01T10:00:00+01:00"),
    );
    const result = await pushChange(
      google,
      "a",
      change({ base: { etag: '"v2"' }, mine: { title: "Changed in Madeora" } }),
    );
    expect(result).toMatchObject({ outcome: "changed", theirs: { title: "Changed in Google" } });
    expect(google.events.get("e1")?.summary).toBe("Changed in Google");
  });

  it("reports an edit of an event deleted in Google as a deletion", async () => {
    const google = new FakeGoogle();
    const result = await pushChange(
      google,
      "a",
      change({ base: { etag: '"v9"' }, mine: { title: "x" } }),
    );
    expect(result).toEqual({ outcome: "changed", theirs: { deleted: true } });
  });

  it("restores an event deleted in Google when the person kept Madeora's version", async () => {
    const google = new FakeGoogle();
    google.put({
      ...timed("e1", "Gone", "2026-12-01T09:00:00+01:00", "2026-12-01T10:00:00+01:00"),
      status: "cancelled",
    });
    const result = await pushChange(
      google,
      "a",
      change({
        base: { deleted: true },
        fields: ["title"],
        mine: mineTimed("Back", "2026-12-01T08:00:00Z", "2026-12-01T09:00:00Z"),
      }),
    );
    expect(result.outcome).toBe("done");
    expect(google.calls).toEqual(["patch e1"]);
    expect(google.bodies[0]).toMatchObject({ status: "confirmed", summary: "Back" });
  });

  it("deletes with the etag; already gone is done; changed in Google is handed back", async () => {
    const google = new FakeGoogle();
    const stored = google.put(
      timed("e1", "A", "2026-12-01T09:00:00+01:00", "2026-12-01T10:00:00+01:00"),
    );
    expect(
      await pushChange(google, "a", change({ action: "delete", base: { etag: stored.etag } })),
    ).toEqual({
      outcome: "done",
      event: null,
    });
    expect(
      await pushChange(google, "a", change({ action: "delete", base: { etag: stored.etag } })),
    ).toEqual({
      outcome: "done",
      event: null,
    });
    google.put(timed("e2", "B", "2026-12-01T09:00:00+01:00", "2026-12-01T10:00:00+01:00"));
    google.put(timed("e2", "B2", "2026-12-01T09:00:00+01:00", "2026-12-01T10:00:00+01:00"));
    const result = await pushChange(
      google,
      "a",
      change({ action: "delete", googleEventId: "e2", base: { etag: '"old"' } }),
    );
    expect(result).toMatchObject({ outcome: "changed", theirs: { title: "B2" } });
    expect(google.events.has("e2")).toBe(true);
  });

  it("fails on a refusal, waits on an outage and stops the run on revoked consent", async () => {
    const google = new FakeGoogle();
    google.put(timed("e1", "A", "2026-12-01T09:00:00+01:00", "2026-12-01T10:00:00+01:00"));
    const edit = change({ base: { etag: null }, mine: { title: "x" } });
    google.failNext = new GoogleHttpError(403, "forbiddenForNonOrganizer");
    expect(await pushChange(google, "a", edit)).toEqual({
      outcome: "failed",
      code: "google_forbidden",
    });
    google.failNext = new GoogleHttpError(503, null);
    expect(await pushChange(google, "a", edit)).toEqual({
      outcome: "retry",
      code: "google_unavailable",
    });
    google.failNext = new GoogleHttpError(0, null);
    expect(await pushChange(google, "a", edit)).toEqual({
      outcome: "retry",
      code: "google_unavailable",
    });
    google.failNext = new GoogleAuthorizationError("unauthorized");
    await expect(pushChange(google, "a", edit)).rejects.toBeInstanceOf(GoogleAuthorizationError);
  });
});

describe("series scopes", () => {
  function series(google: FakeGoogle, recurrence: string[]) {
    const master = google.put({
      ...timed("s1", "Standup", "2026-10-05T09:00:00+02:00", "2026-10-05T09:15:00+02:00"),
      recurrence,
    });
    const occurrence = google.put(
      timed(
        "s1_20261102T080000Z",
        "Standup",
        "2026-11-02T09:00:00+01:00",
        "2026-11-02T09:15:00+01:00",
        {
          recurringEventId: "s1",
          originalStartTime: { dateTime: "2026-11-02T09:00:00+01:00", timeZone: "Europe/Brussels" },
        },
      ),
    );
    return { master, occurrence };
  }
  const base = (etag: string) => ({
    etag,
    allDay: false,
    startsAt: "2026-11-02T08:00:00Z",
    endsAt: "2026-11-02T08:15:00Z",
    timeZone: "Europe/Brussels",
    originalStart: "2026-11-02T09:00:00+01:00",
    recurringEventId: "s1",
  });

  it("edits all events on the series, keeping each date, with the new time of day", async () => {
    const google = new FakeGoogle();
    const { master, occurrence } = series(google, ["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    const result = await pushChange(
      google,
      "a",
      change({
        scope: "all",
        seriesId: "s1",
        googleEventId: occurrence.id,
        fields: ["title", "time"],
        base: base(occurrence.etag),
        mine: mineTimed("Daily sync", "2026-11-02T09:30:00Z", "2026-11-02T10:00:00Z"),
      }),
    );
    expect(result.outcome).toBe("done");
    expect(google.calls).toEqual([`get ${occurrence.id}`, "get s1", `patch s1 if ${master.etag}`]);
    expect(google.bodies[0]).toEqual({
      summary: "Daily sync",
      start: { dateTime: "2026-10-05T10:30:00", timeZone: "Europe/Brussels" },
      end: { dateTime: "2026-10-05T11:00:00", timeZone: "Europe/Brussels" },
    });
  });

  it("splits this and following: a new series from the occurrence, the old one ends before it", async () => {
    const google = new FakeGoogle();
    const { occurrence } = series(google, ["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    const split = change({
      scope: "following",
      seriesId: "s1",
      googleEventId: occurrence.id,
      fields: ["title"],
      base: base(occurrence.etag),
      mine: { ...base(occurrence.etag), title: "New standup" },
    });
    expect((await pushChange(google, "a", split)).outcome).toBe("done");
    const fresh = google.events.get(splitSeriesId(split.id));
    expect(fresh).toMatchObject({
      summary: "New standup",
      start: { dateTime: "2026-11-02T09:00:00", timeZone: "Europe/Brussels" },
      end: { dateTime: "2026-11-02T09:15:00", timeZone: "Europe/Brussels" },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    expect(google.events.get("s1")?.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T075959Z",
    ]);
    // A retry after a lost answer makes no second series.
    google.put({ ...google.events.get(occurrence.id), id: occurrence.id, etag: occurrence.etag });
    const size = google.events.size;
    await pushChange(google, "a", {
      ...split,
      base: base(google.events.get(occurrence.id)?.etag ?? ""),
    });
    expect(google.events.size).toBe(size);
  });

  it("takes the new series back out when Google refuses to end the old one", async () => {
    const google = new FakeGoogle();
    const { occurrence } = series(google, ["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    const refusing = Object.assign(google, {
      patchEvent: (_a: string, _c: string, id: string) => {
        google.calls.push(`patch ${id}`);
        return Promise.reject(new GoogleHttpError(400, "invalid"));
      },
    });
    const split = change({
      scope: "following",
      seriesId: "s1",
      googleEventId: occurrence.id,
      base: base(occurrence.etag),
      mine: { ...base(occurrence.etag), title: "New standup" },
    });
    expect((await pushChange(refusing, "a", split)).outcome).toBe("failed");
    expect(google.events.has(splitSeriesId(split.id))).toBe(false);
    expect(google.events.get("s1")?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
  });

  it("replaces the whole series when it splits at the first occurrence, keeping the series' time", async () => {
    const google = new FakeGoogle();
    const master = google.put({
      ...timed("s2", "Yoga", "2026-11-02T09:00:00+01:00", "2026-11-02T10:00:00+01:00"),
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    // The first occurrence was moved to 11:00 on its own; a title-only split keeps the series' 09:00.
    const first = google.put(
      timed("s2_1", "Yoga", "2026-11-02T11:00:00+01:00", "2026-11-02T12:00:00+01:00", {
        recurringEventId: "s2",
        originalStartTime: { dateTime: "2026-11-02T09:00:00+01:00", timeZone: "Europe/Brussels" },
      }),
    );
    const split = change({
      scope: "following",
      seriesId: "s2",
      googleEventId: first.id,
      base: {
        etag: first.etag,
        allDay: false,
        startsAt: "2026-11-02T10:00:00Z",
        endsAt: "2026-11-02T11:00:00Z",
        timeZone: "Europe/Brussels",
        originalStart: "2026-11-02T09:00:00+01:00",
        recurringEventId: "s2",
      },
      mine: { title: "Pilates" },
    });
    expect((await pushChange(google, "a", split)).outcome).toBe("done");
    expect(google.calls).toContain(`delete s2 if ${master.etag}`);
    expect(google.events.get(splitSeriesId(split.id))).toMatchObject({
      summary: "Pilates",
      start: { dateTime: "2026-11-02T09:00:00", timeZone: "Europe/Brussels" },
      end: { dateTime: "2026-11-02T10:00:00", timeZone: "Europe/Brussels" },
    });
  });

  it("refuses to split a counted series instead of guessing the remaining count", async () => {
    const google = new FakeGoogle();
    const { occurrence } = series(google, ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=20"]);
    const result = await pushChange(
      google,
      "a",
      change({
        scope: "following",
        seriesId: "s1",
        googleEventId: occurrence.id,
        base: base(occurrence.etag),
        mine: { ...base(occurrence.etag), title: "x" },
      }),
    );
    expect(result).toEqual({ outcome: "failed", code: "series_limit" });
    expect(google.events.get("s1")?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=20"]);
  });

  it("deletes this and following by ending the series (a count gives way), all by deleting it", async () => {
    const google = new FakeGoogle();
    const { occurrence } = series(google, ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=20"]);
    await pushChange(
      google,
      "a",
      change({
        action: "delete",
        scope: "following",
        seriesId: "s1",
        googleEventId: occurrence.id,
        base: base(occurrence.etag),
      }),
    );
    expect(google.events.get("s1")?.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T075959Z",
    ]);
    await pushChange(
      google,
      "a",
      change({
        action: "delete",
        scope: "all",
        seriesId: "s1",
        googleEventId: occurrence.id,
        base: base(occurrence.etag),
      }),
    );
    expect(google.events.has("s1")).toBe(false);
  });

  it("hands back an occurrence Google changed since the person saw it, touching nothing", async () => {
    const google = new FakeGoogle();
    const { occurrence } = series(google, ["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    const result = await pushChange(
      google,
      "a",
      change({
        scope: "all",
        seriesId: "s1",
        googleEventId: occurrence.id,
        base: base('"stale"'),
        mine: { title: "x" },
      }),
    );
    expect(result).toMatchObject({ outcome: "changed", theirs: { title: "Standup" } });
    expect(google.calls).toEqual([`get ${occurrence.id}`]);
  });
});

describe("sending all waiting changes", () => {
  it("tries a change again in the same run when the database merged Google's newer version", async () => {
    const google = new FakeGoogle();
    google.put(timed("e1", "A", "2026-12-01T09:00:00+01:00", "2026-12-01T10:00:00+01:00"));
    const current = google.put(
      timed("e1", "A", "2026-12-01T09:00:00+01:00", "2026-12-01T10:00:00+01:00", {
        location: "Room 1",
      }),
    );
    const results: PushResult[] = [];
    const store: PushStore = {
      pushChanges: () =>
        Promise.resolve([change({ base: { etag: '"v2"' }, mine: { title: "B" } })]),
      pushResult: (_id, _lease, _version, result): Promise<PushAnswer> => {
        results.push(result);
        if (result.outcome === "changed") {
          return Promise.resolve({
            state: "pending",
            version: 1,
            base: { etag: current.etag },
            mine: { title: "B" },
            fields: ["title"],
            action: "update",
          });
        }
        return Promise.resolve({ state: result.outcome });
      },
    };
    expect(await pushChanges(store, google, "a", "c", "l")).toEqual({ sent: 1, waiting: 0 });
    expect(results.map((r) => r.outcome)).toEqual(["changed", "done"]);
    expect(google.events.get("e1")?.summary).toBe("B");
  });
});
