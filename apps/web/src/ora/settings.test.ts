import {
  defaultOraSettings,
  inQuietHours,
  oraPatchSchema,
  paletteFor,
  type OraSettings,
} from "./settings";

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

describe("paletteFor", () => {
  const settings: OraSettings = {
    ...defaultOraSettings,
    personalPalette: "denim",
    homePalettes: { [HOME_ID]: "olive" },
  };

  it("uses the Home's own colour, Personal's in Personal, and Heather for a Home never chosen", () => {
    expect(paletteFor(settings, HOME_ID)).toBe("olive");
    expect(paletteFor(settings, null)).toBe("denim");
    expect(paletteFor(settings, "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002")).toBe("heather");
  });
});

describe("oraPatchSchema", () => {
  it("accepts one or more known fields", () => {
    expect(oraPatchSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(oraPatchSchema.safeParse({ teasersMuted: true }).success).toBe(true);
    expect(oraPatchSchema.safeParse({ motion: "reactions", intro: "completed" }).success).toBe(
      true,
    );
  });

  it("refuses an empty change, unknown fields and values outside the lists", () => {
    for (const value of [
      {},
      { other: 1 },
      { motion: "fast" },
      { intro: null },
      { personalPalette: "pink" },
      { teasersMuted: "yes" },
      { homePalette: { homeId: "x", palette: "olive" } },
    ]) {
      expect(oraPatchSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("controls (S47b)", () => {
  it("accepts a frequency, category switches and quiet hours, and rejects bad values", () => {
    expect(oraPatchSchema.safeParse({ frequency: "quiet" }).success).toBe(true);
    expect(oraPatchSchema.safeParse({ frequency: "loud" }).success).toBe(false);
    expect(oraPatchSchema.safeParse({ categories: { celebrations: false } }).success).toBe(true);
    expect(oraPatchSchema.safeParse({ categories: { chat: true } }).success).toBe(false);
    expect(oraPatchSchema.safeParse({ quietHours: { start: "22:00", end: "07:00" } }).success).toBe(
      true,
    );
    expect(oraPatchSchema.safeParse({ quietHours: null }).success).toBe(true);
    expect(oraPatchSchema.safeParse({ quietHours: { start: "25:00", end: "07:00" } }).success).toBe(
      false,
    );
    expect(oraPatchSchema.safeParse({ quietHours: { start: "08:00", end: "08:00" } }).success).toBe(
      false,
    );
  });

  it("works out quiet hours, also across midnight and in another time zone", () => {
    const night = { start: "22:00", end: "07:00" };
    const day = { start: "13:00", end: "14:30" };
    expect(inQuietHours(null, new Date("2026-11-16T12:00:00Z"), "UTC")).toBe(false);
    expect(inQuietHours(night, new Date("2026-11-16T23:30:00Z"), "UTC")).toBe(true);
    expect(inQuietHours(night, new Date("2026-11-16T06:59:00Z"), "UTC")).toBe(true);
    expect(inQuietHours(night, new Date("2026-11-16T07:00:00Z"), "UTC")).toBe(false);
    expect(inQuietHours(day, new Date("2026-11-16T13:00:00Z"), "UTC")).toBe(true);
    expect(inQuietHours(day, new Date("2026-11-16T14:30:00Z"), "UTC")).toBe(false);
    // 21:30 UTC is 22:30 in Amsterdam (winter time).
    expect(inQuietHours(night, new Date("2026-11-16T21:30:00Z"), "Europe/Amsterdam")).toBe(true);
    expect(inQuietHours(night, new Date("2026-11-16T21:30:00Z"), "UTC")).toBe(false);
  });
});
