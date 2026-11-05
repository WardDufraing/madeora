// S32: the calendar contract checks shapes before the database, which checks everything again.
import {
  calendarPageQuerySchema,
  createEventSchema,
  deleteEventSchema,
  eventFieldsSchema,
  sharesSchema,
  timeZoneSchema,
  updateEventSchema,
  windowQuerySchema,
} from "./schema";
import { EVENT, HOME } from "./testing";

const timed = {
  title: "Dentist",
  allDay: false,
  startsOn: "2026-11-10",
  endsOn: "2026-11-10",
  startTime: "09:00",
  endTime: "10:00",
  timezone: "Europe/Brussels",
};
const issues = (value: unknown) =>
  eventFieldsSchema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];

describe("event fields", () => {
  it("accept a timed and an all-day event, and empty optional text as none", () => {
    expect(eventFieldsSchema.parse({ ...timed, location: "  ", description: "" })).toMatchObject({
      location: null,
      description: null,
    });
    expect(
      eventFieldsSchema.safeParse({
        ...timed,
        allDay: true,
        startTime: null,
        endTime: null,
        endsOn: "2027-11-10",
      }).success,
    ).toBe(true);
  });

  it("refuse mixed time shapes, ends before starts, and events that are too long", () => {
    expect(issues({ ...timed, startTime: null })).toEqual(["time"]);
    expect(issues({ ...timed, endTime: "09:00" })).toEqual(["dateOrder"]);
    expect(issues({ ...timed, endsOn: "2026-11-09" })).toEqual(["dateOrder"]);
    expect(issues({ ...timed, endsOn: "2026-11-25" })).toEqual(["tooLong"]);
    expect(issues({ ...timed, endsOn: "2026-11-24", endTime: "09:00" })).toEqual([]);
    expect(issues({ ...timed, endsOn: "2026-11-24" })).toEqual(["tooLong"]);
    expect(
      issues({ ...timed, allDay: true, startTime: null, endTime: null, endsOn: "2027-11-11" }),
    ).toEqual(["tooLong"]);
  });

  it("refuse titles with line breaks, empty titles and unknown timezones", () => {
    expect(eventFieldsSchema.safeParse({ ...timed, title: "a\nb" }).success).toBe(false);
    expect(eventFieldsSchema.safeParse({ ...timed, title: "" }).success).toBe(false);
    expect(eventFieldsSchema.safeParse({ ...timed, title: "x".repeat(201) }).success).toBe(false);
    expect(timeZoneSchema.safeParse("Mars/Olympus").success).toBe(false);
    expect(timeZoneSchema.safeParse("America/Argentina/Buenos_Aires").success).toBe(true);
  });

  it("check a weekly rule's weekdays and its end", () => {
    const repeat = { frequency: "weekly", interval: 1, weekdays: [2], endsOn: null, count: 6 };
    expect(issues({ ...timed, repeat })).toEqual([]);
    expect(issues({ ...timed, repeat: { ...repeat, weekdays: [3] } })).toEqual(["startWeekday"]);
    expect(issues({ ...timed, repeat: { ...repeat, weekdays: null } })).toEqual(["invalid"]);
    expect(issues({ ...timed, repeat: { ...repeat, endsOn: "2026-12-01" } })).toEqual(["invalid"]);
    expect(issues({ ...timed, repeat: { ...repeat, count: null, endsOn: "2026-11-01" } })).toEqual([
      "dateOrder",
    ]);
    expect(
      eventFieldsSchema.safeParse({ ...timed, repeat: { ...repeat, interval: 100 } }).success,
    ).toBe(false);
  });

  it("cap participants and shares", () => {
    const ids = Array.from(
      { length: 21 },
      (_, index) => `0b0e0000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(eventFieldsSchema.safeParse({ ...timed, participants: ids }).success).toBe(false);
    expect(eventFieldsSchema.safeParse({ ...timed, shares: ids.slice(0, 20) }).success).toBe(true);
  });
});

describe("requests", () => {
  it("need a client id to create, a revision to change, and know the three scopes", () => {
    expect(createEventSchema.safeParse({ id: EVENT, homeId: null, event: timed }).success).toBe(
      true,
    );
    expect(createEventSchema.safeParse({ homeId: HOME, event: timed }).success).toBe(false);
    expect(
      updateEventSchema.safeParse({
        revision: 1,
        scope: "following",
        on: "2026-11-17",
        event: timed,
      }).success,
    ).toBe(true);
    expect(
      updateEventSchema.safeParse({ revision: 1, scope: "some", on: null, event: timed }).success,
    ).toBe(false);
    expect(deleteEventSchema.safeParse({ revision: 0, scope: null, on: null }).success).toBe(false);
    expect(sharesSchema.safeParse({ revision: 1, homeIds: [HOME, HOME] }).success).toBe(false);
  });

  it("limit a read to fewer than 62 days and fall back to a month view", () => {
    expect(windowQuerySchema.safeParse({ from: "2026-11-01", to: "2026-12-31" }).success).toBe(
      true,
    );
    expect(windowQuerySchema.safeParse({ from: "2026-11-01", to: "2027-01-02" }).success).toBe(
      false,
    );
    expect(windowQuerySchema.safeParse({ from: "2026-11-02", to: "2026-11-01" }).success).toBe(
      false,
    );
    expect(calendarPageQuerySchema.parse({ view: "year", date: "soon" })).toEqual({
      view: "month",
      date: undefined,
    });
  });
});
