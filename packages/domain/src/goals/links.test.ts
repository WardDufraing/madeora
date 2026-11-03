import { describe, expect, it } from "vitest";

import {
  areLinkUnitsCompatible,
  goalLinkStartDate,
  linkConversionRounds,
  linkedThousandths,
} from "./links";

const km = { unit: "km", kind: "preset" } as const;
const m = { unit: "m", kind: "preset" } as const;
const l = { unit: "l", kind: "preset" } as const;
const pages = { unit: "pages", kind: "preset" } as const;
const laps = { unit: "laps", kind: "custom" } as const;

describe("linkedThousandths", () => {
  it("keeps the same unit and the same custom label", () => {
    expect(linkedThousandths(2500, km, km)).toBe(2500);
    expect(linkedThousandths(3000, pages, pages)).toBe(3000);
    expect(linkedThousandths(1250, laps, laps)).toBe(1250);
  });

  it("converts inside a dimension exactly, rounding half up to thousandths", () => {
    expect(linkedThousandths(2500, km, m)).toBe(2_500_000);
    expect(linkedThousandths(1_234_567, m, km)).toBe(1235);
    expect(linkedThousandths(1_234_499, m, km)).toBe(1234);
    expect(
      linkedThousandths(90_000, { unit: "min", kind: "preset" }, { unit: "h", kind: "preset" }),
    ).toBe(1500);
  });

  it("never converts across dimensions, custom labels or presets named like one", () => {
    expect(linkedThousandths(1000, km, l)).toBeNull();
    expect(linkedThousandths(1000, laps, { unit: "rounds", kind: "custom" })).toBeNull();
    expect(linkedThousandths(1000, { unit: "km", kind: "custom" }, km)).toBeNull();
    expect(areLinkUnitsCompatible(km, m)).toBe(true);
    expect(areLinkUnitsCompatible(km, pages)).toBe(false);
  });
});

describe("goalLinkStartDate", () => {
  const facts = { today: "2026-10-29", firstStart: "2026-09-01" };

  it("starts today, at the beginning or on a chosen date in between", () => {
    expect(goalLinkStartDate("today", facts)).toBe("2026-10-29");
    expect(goalLinkStartDate("beginning", facts)).toBe("2026-09-01");
    expect(goalLinkStartDate("date", { ...facts, date: "2026-10-01" })).toBe("2026-10-01");
    expect(goalLinkStartDate("date", { ...facts, date: "2026-09-01" })).toBe("2026-09-01");
  });

  it("refuses a date before the habit started, after today, or none", () => {
    expect(goalLinkStartDate("date", { ...facts, date: "2026-08-31" })).toBeNull();
    expect(goalLinkStartDate("date", { ...facts, date: "2026-10-30" })).toBeNull();
    expect(goalLinkStartDate("date", facts)).toBeNull();
  });
});

describe("linkConversionRounds", () => {
  it("is true only when the goal's unit is larger than the habit's", () => {
    expect(linkConversionRounds({ unit: "m", kind: "preset" }, km)).toBe(true);
    expect(
      linkConversionRounds({ unit: "min", kind: "preset" }, { unit: "h", kind: "preset" }),
    ).toBe(true);
    expect(linkConversionRounds(km, { unit: "m", kind: "preset" })).toBe(false);
    expect(linkConversionRounds(km, km)).toBe(false);
    expect(
      linkConversionRounds({ unit: "laps", kind: "custom" }, { unit: "laps", kind: "custom" }),
    ).toBe(false);
    expect(linkConversionRounds({ unit: "ml", kind: "preset" }, km)).toBe(false);
  });
});
