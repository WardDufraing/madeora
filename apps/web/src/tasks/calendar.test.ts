import {
  addDays,
  calendarQueryString,
  calendarWindow,
  daysBetween,
  defaultCalendarQuery,
  hasCalendarFilters,
  inMonth,
  parseCalendarQuery,
} from "./calendar";
import { TASK_LIMITS } from "./schema";

const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";

describe("calendarWindow", () => {
  it("builds a Monday week around any of its days", () => {
    const week = calendarWindow("week", "2026-10-22", "monday");
    expect(week).toMatchObject({
      anchor: "2026-10-19",
      from: "2026-10-19",
      to: "2026-10-25",
      previous: "2026-10-12",
      next: "2026-10-26",
    });
    expect(week.weeks).toEqual([
      [
        "2026-10-19",
        "2026-10-20",
        "2026-10-21",
        "2026-10-22",
        "2026-10-23",
        "2026-10-24",
        "2026-10-25",
      ],
    ]);
  });

  it("follows the person's first day of the week", () => {
    expect(calendarWindow("week", "2026-10-22", "sunday").from).toBe("2026-10-18");
    expect(calendarWindow("week", "2026-10-22", "saturday").from).toBe("2026-10-17");
    expect(calendarWindow("week", "2026-10-17", "saturday").from).toBe("2026-10-17");
  });

  it("covers a month in whole weeks, never more than the database allows", () => {
    for (let month = 1; month <= 12; month += 1) {
      for (const start of ["monday", "sunday", "saturday"] as const) {
        const date = `2026-${String(month).padStart(2, "0")}-15`;
        const view = calendarWindow("month", date, start);
        const days = daysBetween(view.from, view.to) + 1;
        expect(days % 7).toBe(0);
        expect(days).toBeLessThanOrEqual(TASK_LIMITS.calendarDays);
        expect(view.weeks.flat()).toHaveLength(days);
        expect(view.from <= `${date.slice(0, 7)}-01`).toBe(true);
      }
    }
  });

  it("starts and ends a month on the right days, across a DST change and month edges", () => {
    // October 2026: Europe's clocks change on the 25th; dates are plain days, so nothing shifts.
    const october = calendarWindow("month", "2026-10-31", "monday");
    expect(october).toMatchObject({
      anchor: "2026-10-01",
      from: "2026-09-28",
      to: "2026-11-01",
      previous: "2026-09-01",
      next: "2026-11-01",
    });
    expect(october.weeks).toHaveLength(5);
    expect(october.weeks[3]?.at(-1)).toBe("2026-10-25");
    expect(october.weeks[4]?.[0]).toBe("2026-10-26");
    expect(inMonth("2026-09-30", october.anchor)).toBe(false);
    expect(inMonth("2026-10-25", october.anchor)).toBe(true);
  });

  it("handles leap days and the turn of the year", () => {
    const february = calendarWindow("month", "2028-02-10", "monday");
    expect(february.weeks.flat()).toContain("2028-02-29");
    expect(calendarWindow("month", "2026-12-05", "monday").next).toBe("2027-01-01");
    expect(calendarWindow("month", "2027-01-31", "monday").previous).toBe("2026-12-01");
    expect(calendarWindow("week", "2026-12-31", "monday").next).toBe("2027-01-04");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  });

  it("needs six rows for a month that spans them", () => {
    // August 2026 starts on a Saturday and has 31 days.
    expect(calendarWindow("month", "2026-08-01", "monday").weeks).toHaveLength(6);
  });
});

describe("calendar address", () => {
  it("reads view, dates and filters, and drops what it does not understand", () => {
    expect(
      parseCalendarQuery({
        view: "week",
        date: "2026-10-20",
        day: "not-a-date",
        list: LIST,
        priority: ["high", "bogus"],
        assignee: MEMBER,
      }),
    ).toEqual({
      ...defaultCalendarQuery,
      view: "week",
      date: "2026-10-20",
      list: LIST,
      assignee: "member",
      member: MEMBER,
    });
    expect(parseCalendarQuery({ assignee: "member" })).toEqual(defaultCalendarQuery);
  });

  it("writes only what differs from the defaults and round-trips", () => {
    const query = parseCalendarQuery({
      view: "week",
      status: "open",
      priority: ["urgent", "unset"],
      assignee: MEMBER,
    });
    const search = calendarQueryString(query, { date: "2026-10-19" });
    expect(search).toBe(
      `view=week&date=2026-10-19&status=open&priority=urgent&priority=unset&assignee=${MEMBER}`,
    );
    const params: Record<string, string | string[]> = {};
    for (const key of new Set(new URLSearchParams(search).keys())) {
      const values = new URLSearchParams(search).getAll(key);
      params[key] = values.length > 1 ? values : (values[0] ?? "");
    }
    expect(parseCalendarQuery(params)).toEqual({ ...query, date: "2026-10-19" });
    expect(calendarQueryString(defaultCalendarQuery)).toBe("");
  });

  it("counts filters but not the list or dates", () => {
    expect(hasCalendarFilters({ ...defaultCalendarQuery, list: LIST, date: "2026-10-01" })).toBe(
      false,
    );
    expect(hasCalendarFilters({ ...defaultCalendarQuery, status: "open" })).toBe(true);
  });
});
