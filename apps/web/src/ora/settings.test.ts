import { defaultOraSettings, oraPatchSchema, paletteFor, type OraSettings } from "./settings";

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
