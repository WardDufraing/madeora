import { greetingPeriod } from "./greeting";

describe("greetingPeriod", () => {
  it("follows the hour in the given time zone", () => {
    const instant = new Date("2026-11-26T09:30:00Z");
    expect(greetingPeriod(instant, "UTC")).toBe("morning");
    expect(greetingPeriod(instant, "Europe/Berlin")).toBe("morning");
    expect(greetingPeriod(instant, "America/New_York")).toBe("morning");
    expect(greetingPeriod(instant, "Asia/Tokyo")).toBe("evening");
  });

  it("changes at noon and at 18:00", () => {
    expect(greetingPeriod(new Date("2026-11-26T11:59:00Z"), "UTC")).toBe("morning");
    expect(greetingPeriod(new Date("2026-11-26T12:00:00Z"), "UTC")).toBe("afternoon");
    expect(greetingPeriod(new Date("2026-11-26T17:59:00Z"), "UTC")).toBe("afternoon");
    expect(greetingPeriod(new Date("2026-11-26T18:00:00Z"), "UTC")).toBe("evening");
  });

  it("treats just after midnight as morning", () => {
    expect(greetingPeriod(new Date("2026-11-26T00:05:00Z"), "UTC")).toBe("morning");
  });
});
