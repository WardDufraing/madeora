// S32: daylight-saving notes in the event form (the database decides again).
import { instantsOf, localTimeKind, nextValidTime } from "./time";

describe("local times in a timezone", () => {
  it("knows a spring-forward gap and offers the next time that exists", () => {
    expect(localTimeKind("2026-03-29", "02:30", "Europe/Brussels")).toBe("nonexistent");
    expect(nextValidTime("2026-03-29", "02:30", "Europe/Brussels")).toBe("03:00");
    expect(localTimeKind("2026-03-08", "02:15", "America/New_York")).toBe("nonexistent");
  });

  it("knows a fall-back overlap, earliest instant first", () => {
    expect(localTimeKind("2026-10-25", "02:30", "Europe/Brussels")).toBe("ambiguous");
    const [first, second] = instantsOf("2026-10-25", "02:30", "Europe/Brussels");
    expect(new Date(first ?? 0).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(new Date(second ?? 0).toISOString()).toBe("2026-10-25T01:30:00.000Z");
  });

  it("finds exactly one instant on an ordinary day, also far from UTC", () => {
    expect(localTimeKind("2026-11-04", "09:00", "Europe/Brussels")).toBe("exists");
    expect(instantsOf("2026-11-04", "09:00", "Pacific/Auckland")).toEqual([
      Date.parse("2026-11-03T20:00:00Z"),
    ]);
    expect(localTimeKind("2026-11-04", "09:00", "UTC")).toBe("exists");
  });
});
