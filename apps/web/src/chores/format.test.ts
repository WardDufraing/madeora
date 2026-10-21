import { describe, expect, it } from "vitest";

import { instantFromZoned, zonedParts } from "./format";

describe("instantFromZoned", () => {
  it("reads a wall-clock time in the given zone", () => {
    expect(instantFromZoned("2026-10-21", "18:05", "Europe/Brussels")).toBe(
      "2026-10-21T16:05:00.000Z",
    );
    expect(instantFromZoned("2026-01-15", "09:30", "Pacific/Auckland")).toBe(
      "2026-01-14T20:30:00.000Z",
    );
    expect(instantFromZoned("2026-07-01", "00:00", "UTC")).toBe("2026-07-01T00:00:00.000Z");
  });

  it("refuses a time skipped by daylight saving", () => {
    expect(instantFromZoned("2026-03-29", "02:30", "Europe/Brussels")).toBeNull();
  });

  it("takes the first of a time that happens twice", () => {
    expect(instantFromZoned("2026-10-25", "02:30", "Europe/Brussels")).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("refuses what is not a date or time", () => {
    expect(instantFromZoned("2026-13-01", "10:00", "UTC")).toBeNull();
    expect(instantFromZoned("2026-02-30", "10:00", "UTC")).toBeNull();
    expect(instantFromZoned("2026-02-01", "1000", "UTC")).toBeNull();
  });

  it("round-trips with zonedParts", () => {
    const instant = "2026-10-21T16:05:00.000Z";
    const { date, time } = zonedParts(instant, "Europe/Brussels");
    expect([date, time]).toEqual(["2026-10-21", "18:05"]);
    expect(instantFromZoned(date, time, "Europe/Brussels")).toBe(instant);
  });
});
