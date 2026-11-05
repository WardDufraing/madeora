import { describe, expect, it } from "vitest";

import {
  SeriesLimitError,
  continueRecurrence,
  endRecurrence,
  instantOf,
  rruleFor,
  untilBefore,
  wallClock,
  type RepeatRule,
} from "./recurrence.ts";

const rule = (extra: Partial<RepeatRule>): RepeatRule => ({
  frequency: "daily",
  interval: 1,
  weekdays: null,
  endsOn: null,
  count: null,
  ...extra,
});

describe("local times", () => {
  it("shows an instant as the wall-clock time of a zone", () => {
    expect(wallClock(Date.parse("2026-07-01T07:30:00Z"), "Europe/Brussels")).toBe(
      "2026-07-01T09:30:00",
    );
    expect(wallClock(Date.parse("2026-12-01T08:30:00Z"), "Europe/Brussels")).toBe(
      "2026-12-01T09:30:00",
    );
  });

  it("finds the instant of a local time, standard time in a fall-back overlap", () => {
    expect(new Date(instantOf("2026-12-01T09:00", "Europe/Brussels") ?? 0).toISOString()).toBe(
      "2026-12-01T08:00:00.000Z",
    );
    // 25 October 2026, 02:30 happens twice in Brussels: the second one (CET) is taken.
    expect(new Date(instantOf("2026-10-25T02:30", "Europe/Brussels") ?? 0).toISOString()).toBe(
      "2026-10-25T01:30:00.000Z",
    );
  });

  it("moves a time in a spring-forward gap forward by the gap", () => {
    // 29 March 2026, 02:30 does not exist in Brussels; it becomes 03:30 CEST.
    expect(new Date(instantOf("2026-03-29T02:30", "Europe/Brussels") ?? 0).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });
});

describe("RRULE from Madeora's repeat rule", () => {
  it("writes daily, weekly and every-n rules", () => {
    expect(rruleFor(rule({}), "2026-12-01", null)).toBe("RRULE:FREQ=DAILY");
    expect(
      rruleFor(rule({ frequency: "weekly", interval: 2, weekdays: [5, 1] }), "2026-11-30", null),
    ).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR");
  });

  it("keeps the last-day fallback for the 29th to the 31st", () => {
    expect(rruleFor(rule({ frequency: "monthly" }), "2026-01-15", null)).toBe("RRULE:FREQ=MONTHLY");
    expect(rruleFor(rule({ frequency: "monthly" }), "2026-01-31", null)).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1",
    );
    expect(rruleFor(rule({ frequency: "monthly" }), "2026-01-30", null)).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1",
    );
  });

  it("puts 29 February on 28 February in other years", () => {
    expect(rruleFor(rule({ frequency: "yearly" }), "2028-02-29", null)).toBe(
      "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1",
    );
  });

  it("ends on a date: the date for all-day, the end of that local day in UTC for timed", () => {
    expect(rruleFor(rule({ endsOn: "2027-01-31" }), "2026-12-01", null)).toBe(
      "RRULE:FREQ=DAILY;UNTIL=20270131",
    );
    // Brussels is UTC+2 in summer: the end of 1 July is 21:59:59 UTC.
    expect(rruleFor(rule({ endsOn: "2026-07-01" }), "2026-06-01", "Europe/Brussels")).toBe(
      "RRULE:FREQ=DAILY;UNTIL=20260701T215959Z",
    );
    expect(rruleFor(rule({ count: 10 }), "2026-12-01", "Europe/Brussels")).toBe(
      "RRULE:FREQ=DAILY;COUNT=10",
    );
  });
});

describe("series splits", () => {
  it("ends a timed series one second before the occurrence, in UTC, across a DST change", () => {
    // A 09:00 Brussels series split at an occurrence after the October change (CET, UTC+1).
    expect(untilBefore("2026-11-02T09:00:00+01:00")).toBe("20261102T075959Z");
    // And one before it (CEST, UTC+2).
    expect(untilBefore("2026-10-19T09:00:00+02:00")).toBe("20261019T065959Z");
  });

  it("ends an all-day series on the day before", () => {
    expect(untilBefore("2026-03-01")).toBe("20260228");
  });

  it("replaces a count or a later end with the new end and keeps exception dates", () => {
    expect(
      endRecurrence(
        ["RRULE:FREQ=WEEKLY;COUNT=20;BYDAY=MO", "EXDATE;TZID=Europe/Brussels:20261109T090000"],
        "20261102T075959Z",
      ),
    ).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T075959Z",
      "EXDATE;TZID=Europe/Brussels:20261109T090000",
    ]);
    expect(endRecurrence(["RRULE:FREQ=DAILY;UNTIL=20261001"], "20261102T075959Z")).toEqual([
      "RRULE:FREQ=DAILY;UNTIL=20261001",
    ]);
  });

  it("refuses series it cannot change safely", () => {
    expect(() => continueRecurrence(["RRULE:FREQ=DAILY;COUNT=5"])).toThrow(SeriesLimitError);
    expect(() => endRecurrence(["RRULE:FREQ=DAILY", "RDATE:20261224"], "20261201")).toThrow(
      SeriesLimitError,
    );
    expect(() => endRecurrence([], "20261201")).toThrow(SeriesLimitError);
    expect(continueRecurrence(["RRULE:FREQ=DAILY;UNTIL=20270101"])).toEqual([
      "RRULE:FREQ=DAILY;UNTIL=20270101",
    ]);
  });
});
