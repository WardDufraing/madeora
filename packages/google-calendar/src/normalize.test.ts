import { describe, expect, it } from "vitest";

import { normalizeCalendar, normalizeEvent, singleLine } from "./normalize.ts";

describe("calendar list entries", () => {
  it("keeps the id, the person's own name for it, the zone, role and primary flag", () => {
    expect(
      normalizeCalendar({
        id: "alice@gmail.com",
        summary: "alice@gmail.com",
        summaryOverride: "Mijn agenda",
        timeZone: "Europe/Brussels",
        accessRole: "owner",
        primary: true,
      }),
    ).toEqual({
      id: "alice@gmail.com",
      name: "Mijn agenda",
      timeZone: "Europe/Brussels",
      accessRole: "owner",
      primary: true,
    });
  });

  it("drops deleted or unknown entries and falls back to the id for a blank name", () => {
    expect(normalizeCalendar({ id: "x", accessRole: "owner", deleted: true })).toBeNull();
    expect(normalizeCalendar({ id: "x", accessRole: "admin" })).toBeNull();
    expect(normalizeCalendar({ accessRole: "owner" })).toBeNull();
    expect(normalizeCalendar({ id: "fam@group", summary: "  ", accessRole: "reader" })?.name).toBe(
      "fam@group",
    );
  });
});

describe("events", () => {
  it("stores an all-day event with Google's exclusive end as the last day", () => {
    const event = normalizeEvent({
      id: "a1",
      status: "confirmed",
      summary: "Reis",
      start: { date: "2026-12-10" },
      end: { date: "2026-12-13" },
    });
    expect(event).toMatchObject({ allDay: true, startsOn: "2026-12-10", endsOn: "2026-12-12" });
    expect(
      normalizeEvent({ id: "a2", start: { date: "2026-12-10" }, end: { date: "2026-12-11" } }),
    ).toMatchObject({ startsOn: "2026-12-10", endsOn: "2026-12-10" });
  });

  it("stores timed events as instants with their zone, never ending before they start", () => {
    expect(
      normalizeEvent({
        id: "t1",
        start: { dateTime: "2026-12-03T09:00:00+01:00", timeZone: "Europe/Brussels" },
        end: { dateTime: "2026-12-03T10:00:00+01:00", timeZone: "Europe/Brussels" },
      }),
    ).toMatchObject({
      allDay: false,
      startsAt: "2026-12-03T08:00:00.000Z",
      endsAt: "2026-12-03T09:00:00.000Z",
      timeZone: "Europe/Brussels",
    });
    expect(
      normalizeEvent({
        id: "t2",
        start: { dateTime: "2026-12-03T10:00:00Z" },
        end: { dateTime: "2026-12-03T09:00:00Z" },
      }),
    ).toMatchObject({ endsAt: "2026-12-03T10:00:00.000Z" });
  });

  it("keeps a cancelled instance as a removal", () => {
    expect(normalizeEvent({ id: "c1", status: "cancelled" })).toEqual({
      id: "c1",
      cancelled: true,
    });
  });

  it("cuts and cleans text to Madeora's limits", () => {
    const event = normalizeEvent({
      id: "x",
      summary: `Line one\nline two\u0007 ${"x".repeat(300)}`,
      location: "   ",
      description: "d".repeat(5000),
      start: { date: "2026-12-01" },
      end: { date: "2026-12-02" },
    });
    expect(event && "title" in event ? event.title : null).toMatch(/^Line one line two {2}x+$/);
    expect(event && "title" in event ? Array.from(event.title ?? "").length : 0).toBe(200);
    expect(event && "location" in event ? event.location : "set").toBeNull();
    expect(event && "description" in event ? event.description?.length : 0).toBe(4000);
    expect(singleLine("\t\r\n", 10)).toBeNull();
  });

  it("marks private and confidential events and keeps only real Google links", () => {
    const base = { id: "p", start: { date: "2026-12-01" }, end: { date: "2026-12-02" } };
    expect(normalizeEvent({ ...base, visibility: "private" })).toMatchObject({ private: true });
    expect(normalizeEvent({ ...base, visibility: "confidential" })).toMatchObject({
      private: true,
    });
    expect(normalizeEvent({ ...base, visibility: "default" })).toMatchObject({ private: false });
    expect(
      normalizeEvent({ ...base, htmlLink: "https://www.google.com/calendar/event?eid=abc" }),
    ).toMatchObject({ link: "https://www.google.com/calendar/event?eid=abc" });
    expect(normalizeEvent({ ...base, htmlLink: "https://evil.example/calendar/" })).toMatchObject({
      link: null,
    });
  });

  it("keeps the series and the original start of a recurring instance", () => {
    expect(
      normalizeEvent({
        id: "s_20261205",
        recurringEventId: "s",
        originalStartTime: { dateTime: "2026-12-05T18:00:00+01:00" },
        start: { dateTime: "2026-12-05T18:00:00+01:00" },
        end: { dateTime: "2026-12-05T19:00:00+01:00" },
      }),
    ).toMatchObject({ recurringEventId: "s", originalStart: "2026-12-05T18:00:00+01:00" });
  });

  it("drops what cannot be stored", () => {
    expect(normalizeEvent({ id: "n", start: { date: "2026-12-01" } })).toBeNull();
    expect(normalizeEvent({ id: "n", start: { date: "nope" }, end: { date: "x" } })).toBeNull();
    expect(
      normalizeEvent({ start: { date: "2026-12-01" }, end: { date: "2026-12-02" } }),
    ).toBeNull();
    expect(normalizeEvent(null)).toBeNull();
  });
});
