// S32: the calendar's windows and day placement work on local dates only.
import {
  bannerSpan,
  calendarHref,
  calendarViewWindow,
  editEventPath,
  eventPath,
  newEventPath,
  occurrencePath,
  occurrencesByDate,
  occurrenceTimes,
} from "./format";
import { CALENDAR_LIMITS } from "./schema";
import { occurrence } from "./testing";

const formats = {
  timeZone: "UTC",
  dateFormat: "dmy-slash",
  timeFormat: "24h",
  locale: "en",
} as const;

describe("addresses", () => {
  it("are Personal or the Home's, with an occurrence date when given", () => {
    expect(eventPath(null, "e1")).toBe("/calendar/events/e1");
    expect(eventPath("h1", "e1", "2026-11-17")).toBe("/homes/h1/calendar/events/e1?on=2026-11-17");
    expect(editEventPath("h1", "e1")).toBe("/homes/h1/calendar/events/e1/edit");
    expect(newEventPath(null, "2026-11-04")).toBe("/calendar/new?date=2026-11-04");
    expect(calendarHref(null, "month")).toBe("/calendar");
    expect(calendarHref("h1", "week", "2026-11-04")).toBe(
      "/homes/h1/calendar?view=week&date=2026-11-04",
    );
  });

  it("lead a Google event to its read-only page (S33)", () => {
    expect(occurrencePath("h1", occurrence({ source: "google", eventId: "g1", on: null }))).toBe(
      "/homes/h1/calendar/google/g1",
    );
    expect(occurrencePath(null, occurrence({ source: "google", eventId: "g1" }))).toBe(
      "/calendar/google/g1",
    );
    expect(occurrencePath(null, occurrence({ eventId: "e1", on: "2026-11-17" }))).toBe(
      "/calendar/events/e1?on=2026-11-17",
    );
  });
});

describe("view windows", () => {
  it("cover whole weeks for a month, from the person's first weekday", () => {
    const month = calendarViewWindow("month", "2026-11-18", "monday");
    expect(month.from).toBe("2026-10-26");
    expect(month.to).toBe("2026-12-06");
    expect(month.previous).toBe("2026-10-01");
    expect(month.next).toBe("2026-12-01");
    const sunday = calendarViewWindow("week", "2026-11-18", "sunday");
    expect(sunday.from).toBe("2026-11-15");
    expect(sunday.to).toBe("2026-11-21");
  });

  it("move a day or an agenda period at a time, always within one database read", () => {
    const day = calendarViewWindow("day", "2026-03-29", "monday");
    expect([day.from, day.to, day.previous, day.next]).toEqual([
      "2026-03-29",
      "2026-03-29",
      "2026-03-28",
      "2026-03-30",
    ]);
    const agenda = calendarViewWindow("agenda", "2026-12-20", "monday");
    expect(agenda.to).toBe("2027-01-18");
    for (const view of ["month", "week", "day", "agenda"] as const) {
      const window = calendarViewWindow(view, "2026-02-28", "saturday");
      expect(window.weeks.flat().length).toBeLessThan(CALENDAR_LIMITS.windowDays);
    }
  });
});

describe("placing occurrences", () => {
  it("puts an event over several days on each day inside the window", () => {
    const trip = occurrence({ allDay: true, from: "2026-10-30", to: "2026-11-02" });
    const byDate = occurrencesByDate([trip], "2026-11-01", "2026-11-30");
    expect([...byDate.keys()]).toEqual(["2026-11-01", "2026-11-02"]);
  });

  it("says when a timed event starts and ends on each of its days", () => {
    const late = occurrence({
      from: "2026-11-10",
      to: "2026-11-11",
      startsAt: "2026-11-10T22:00:00.000Z",
      endsAt: "2026-11-11T01:00:00.000Z",
    });
    expect(occurrenceTimes(late, "2026-11-10", "UTC", formats)).toEqual({
      start: "22:00",
      end: null,
    });
    expect(occurrenceTimes(late, "2026-11-11", "UTC", formats)).toEqual({
      start: null,
      end: "01:00",
    });
    expect(occurrenceTimes(occurrence({ allDay: true }), "2026-11-10", "UTC", formats)).toBeNull();
  });

  it("spans a vacation banner over its dates in one week row", () => {
    const week = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
    expect(bannerSpan(week, "2026-11-10", "2026-11-11")).toEqual({ start: 1, span: 2 });
    expect(bannerSpan(week, "2026-11-01", "2026-11-30")).toEqual({ start: 0, span: 5 });
    expect(bannerSpan(week, "2026-11-14", "2026-11-20")).toBeNull();
  });
});
