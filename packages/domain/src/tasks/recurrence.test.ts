import { describe, expect, it } from "vitest";

import {
  addDays,
  daysBetween,
  firstOnOrAfter,
  isoWeekday,
  isValidPattern,
  lastDate,
  monthLength,
  upcomingDates,
  type IsoWeekday,
  type RecurrencePattern,
  type RecurrenceRule,
} from "./recurrence";
import vectors from "./recurrence-vectors.json" with { type: "json" };

/** The schedule written as a plain predicate, day by day: the reference the fast version must match. */
function onSchedule(pattern: RecurrencePattern, date: string): boolean {
  if (date < pattern.startsOn) return false;
  const [sy, sm, sd] = pattern.startsOn.split("-").map(Number) as [number, number, number];
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const n = pattern.interval;
  switch (pattern.frequency) {
    case "daily":
      return daysBetween(pattern.startsOn, date) % n === 0;
    case "weekly": {
      const weekOf = (value: string) => addDays(value, 1 - isoWeekday(value));
      const weeks = daysBetween(weekOf(pattern.startsOn), weekOf(date)) / 7;
      return (pattern.weekdays ?? []).includes(isoWeekday(date)) && weeks % n === 0;
    }
    case "monthly":
      return ((y - sy) * 12 + (m - sm)) % n === 0 && d === Math.min(sd, monthLength(y, m));
    case "yearly":
      return (y - sy) % n === 0 && m === sm && d === Math.min(sd, monthLength(y, m));
  }
}

function bruteFirst(pattern: RecurrencePattern, from: string): string {
  let date = from < pattern.startsOn ? pattern.startsOn : from;
  for (let guard = 0; guard < 40_000; guard += 1) {
    if (onSchedule(pattern, date)) return date;
    date = addDays(date, 1);
  }
  throw new Error("no date found");
}

// A small deterministic generator, so a failure names a reproducible case.
function* cases(): Generator<{ pattern: RecurrencePattern; from: string }> {
  let seed = 7;
  const next = (max: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };
  const starts = [
    "2024-01-31",
    "2024-02-29",
    "2026-10-19",
    "2026-12-31",
    "2027-03-30",
    "2028-02-28",
  ];
  for (let index = 0; index < 600; index += 1) {
    const frequency = (["daily", "weekly", "monthly", "yearly"] as const)[next(4)] ?? "daily";
    const interval = [1, 1, 2, 3, 5, 12][next(6)] ?? 1;
    const weekdays =
      frequency === "weekly"
        ? ([...new Set([1 + next(7), 1 + next(7), 1 + next(7)])] as IsoWeekday[])
        : null;
    const startsOn = starts[next(starts.length)] ?? "2026-10-19";
    const from = addDays(startsOn, next(1500) - 100);
    yield { pattern: { frequency, interval, weekdays, startsOn }, from };
  }
}

describe("firstOnOrAfter", () => {
  it("matches the day-by-day definition on 600 generated cases", () => {
    for (const { pattern, from } of cases()) {
      expect(firstOnOrAfter(pattern, from), JSON.stringify({ pattern, from })).toBe(
        bruteFirst(pattern, from),
      );
    }
  });

  it("answers every shared vector (the database test runs the same file)", () => {
    for (const vector of vectors) {
      const pattern = vector.pattern as RecurrencePattern;
      expect(firstOnOrAfter(pattern, vector.from), JSON.stringify(vector)).toBe(vector.expected);
      expect(bruteFirst(pattern, vector.from)).toBe(vector.expected);
    }
  });

  it("falls back to the month's last day for the 29th to 31st", () => {
    const pattern: RecurrencePattern = {
      frequency: "monthly",
      interval: 1,
      weekdays: null,
      startsOn: "2027-01-31",
    };
    expect(upcomingDates({ ...pattern, endsOn: null, count: null }, "2027-01-31", 4)).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
    ]);
  });

  it("puts 29 February on 28 February in other years", () => {
    const rule: RecurrenceRule = {
      frequency: "yearly",
      interval: 1,
      weekdays: null,
      startsOn: "2028-02-29",
      endsOn: null,
      count: null,
    };
    expect(upcomingDates(rule, "2028-01-01", 5)).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
    ]);
  });

  it("counts every other week from the start date's week, Monday to Sunday", () => {
    // 2026-10-21 is a Wednesday; Monday 19 October starts its week.
    const rule: RecurrenceRule = {
      frequency: "weekly",
      interval: 2,
      weekdays: [1, 5],
      startsOn: "2026-10-21",
      endsOn: null,
      count: null,
    };
    expect(upcomingDates(rule, "2026-10-01", 4)).toEqual([
      "2026-10-23",
      "2026-11-02",
      "2026-11-06",
      "2026-11-16",
    ]);
  });

  it("never answers a date before the start", () => {
    const pattern: RecurrencePattern = {
      frequency: "daily",
      interval: 3,
      weekdays: null,
      startsOn: "2026-10-20",
    };
    expect(firstOnOrAfter(pattern, "2020-01-01")).toBe("2026-10-20");
    expect(firstOnOrAfter(pattern, "2026-10-21")).toBe("2026-10-23");
  });

  it("refuses a malformed pattern", () => {
    expect(() =>
      firstOnOrAfter(
        { frequency: "weekly", interval: 1, weekdays: [], startsOn: "2026-10-20" },
        "2026-10-20",
      ),
    ).toThrow(RangeError);
  });
});

describe("isValidPattern", () => {
  const base: RecurrencePattern = {
    frequency: "daily",
    interval: 1,
    weekdays: null,
    startsOn: "2026-10-20",
  };

  it.each<[string, RecurrencePattern, boolean]>([
    ["a daily pattern", base, true],
    ["interval 99", { ...base, interval: 99 }, true],
    ["interval 0", { ...base, interval: 0 }, false],
    ["interval 100", { ...base, interval: 100 }, false],
    ["a fractional interval", { ...base, interval: 1.5 }, false],
    ["weekdays on a daily pattern", { ...base, weekdays: [1] }, false],
    ["weekly without weekdays", { ...base, frequency: "weekly" }, false],
    ["weekly with an empty set", { ...base, frequency: "weekly", weekdays: [] }, false],
    ["weekly with a repeated day", { ...base, frequency: "weekly", weekdays: [1, 1] }, false],
    ["weekly with day 8", { ...base, frequency: "weekly", weekdays: [8 as IsoWeekday] }, false],
    ["weekly every day", { ...base, frequency: "weekly", weekdays: [1, 2, 3, 4, 5, 6, 7] }, true],
    ["an impossible start date", { ...base, startsOn: "2026-02-30" }, false],
    ["a start that is not a date", { ...base, startsOn: "20 Oct" }, false],
  ])("%s", (_name, pattern, valid) => {
    expect(isValidPattern(pattern)).toBe(valid);
  });
});

describe("lastDate and upcomingDates", () => {
  const weekly: RecurrenceRule = {
    frequency: "weekly",
    interval: 1,
    weekdays: [2, 4],
    startsOn: "2026-10-20",
    endsOn: null,
    count: null,
  };

  it("has no last date when it never ends", () => {
    expect(lastDate(weekly)).toBeNull();
  });

  it("ends after the counted occurrences", () => {
    expect(lastDate({ ...weekly, count: 3 })).toBe("2026-10-27");
    expect(upcomingDates({ ...weekly, count: 3 }, "2026-10-01", 10)).toEqual([
      "2026-10-20",
      "2026-10-22",
      "2026-10-27",
    ]);
  });

  it("takes the earlier of an end date and a count", () => {
    expect(lastDate({ ...weekly, count: 10, endsOn: "2026-10-24" })).toBe("2026-10-24");
    expect(upcomingDates({ ...weekly, count: 10, endsOn: "2026-10-24" }, "2026-10-21", 10)).toEqual(
      ["2026-10-22"],
    );
  });

  it("keeps calendar dates across a daylight-saving change", () => {
    // Europe moves its clocks on 25 October 2026; dates are not instants, so nothing shifts.
    expect(upcomingDates({ ...weekly, weekdays: [7] }, "2026-10-20", 2)).toEqual([
      "2026-10-25",
      "2026-11-01",
    ]);
  });
});
