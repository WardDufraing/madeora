import { resolveRange } from "./range";

describe("overview ranges", () => {
  it("resolves today and tomorrow as single local dates, across a month and a year", () => {
    expect(resolveRange({ target: "today" }, "2026-12-31", "monday")).toEqual({
      scope: "day",
      from: "2026-12-31",
      to: "2026-12-31",
    });
    expect(resolveRange({ target: "tomorrow" }, "2026-12-31", "monday")).toEqual({
      scope: "day",
      from: "2027-01-01",
      to: "2027-01-01",
    });
  });

  it("uses a picked day as is", () => {
    expect(resolveRange({ target: "day", date: "2028-02-29" }, "2026-11-13", "sunday")).toEqual({
      scope: "day",
      from: "2028-02-29",
      to: "2028-02-29",
    });
  });

  it("starts the week on the person's first day", () => {
    // 2026-11-13 is a Friday.
    expect(resolveRange({ target: "this-week" }, "2026-11-13", "monday")).toEqual({
      scope: "week",
      from: "2026-11-09",
      to: "2026-11-15",
    });
    expect(resolveRange({ target: "this-week" }, "2026-11-13", "sunday").from).toBe("2026-11-08");
    expect(resolveRange({ target: "this-week" }, "2026-11-13", "saturday").from).toBe("2026-11-07");
  });

  it("finds next week and a picked week, across month, year and DST boundaries", () => {
    expect(resolveRange({ target: "next-week" }, "2026-11-13", "monday")).toEqual({
      scope: "week",
      from: "2026-11-16",
      to: "2026-11-22",
    });
    expect(resolveRange({ target: "week", date: "2026-12-30" }, "2026-11-13", "monday")).toEqual({
      scope: "week",
      from: "2026-12-28",
      to: "2027-01-03",
    });
    // The week of the clock change in Europe (2026-10-25) is still seven dates.
    const dst = resolveRange({ target: "week", date: "2026-10-25" }, "2026-11-13", "monday");
    expect(dst).toEqual({ scope: "week", from: "2026-10-19", to: "2026-10-25" });
  });
});
