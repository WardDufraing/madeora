import { describe, expect, it } from "vitest";

import {
  addThousandths,
  areUnitsConvertible,
  convertThousandths,
  decimalSeparator,
  isValidNumericTracking,
  parseQuantity,
  progressFraction,
  suggestedQuickAdds,
  thousandthsToDecimal,
  toThousandths,
  type HabitUnit,
} from "./index";

const glasses: HabitUnit = { unit: "glasses", kind: "preset" };
const ml: HabitUnit = { unit: "ml", kind: "preset" };
const litres: HabitUnit = { unit: "l", kind: "preset" };
const minutes: HabitUnit = { unit: "min", kind: "preset" };
const hours: HabitUnit = { unit: "h", kind: "preset" };
const cups: HabitUnit = { unit: "cups", kind: "custom" };

describe("localized quantity entry", () => {
  it("reads the decimal separator of the locale", () => {
    expect(decimalSeparator("en")).toBe(".");
    expect(decimalSeparator("nl")).toBe(",");
    expect(decimalSeparator("nl-BE")).toBe(",");
  });

  it("parses a decimal comma in Dutch and a decimal point in English", () => {
    expect(parseQuantity("1,5", "nl")).toEqual({ ok: true, thousandths: 1500 });
    expect(parseQuantity("1.5", "en")).toEqual({ ok: true, thousandths: 1500 });
    expect(parseQuantity("0,125", "nl")).toEqual({ ok: true, thousandths: 125 });
    expect(parseQuantity("2000", "nl")).toEqual({ ok: true, thousandths: 2_000_000 });
    expect(parseQuantity("  8  ", "en")).toEqual({ ok: true, thousandths: 8000 });
  });

  it("refuses the other locale's separator instead of guessing", () => {
    expect(parseQuantity("1.5", "nl")).toEqual({ ok: false, problem: "separator" });
    expect(parseQuantity("1,5", "en")).toEqual({ ok: false, problem: "separator" });
    expect(parseQuantity("1.500", "nl")).toEqual({ ok: false, problem: "separator" });
  });

  it("refuses thousands separators, signs, exponents and malformed text", () => {
    expect(parseQuantity("1.234,5", "nl")).toEqual({ ok: false, problem: "malformed" });
    expect(parseQuantity("1,234.5", "en")).toEqual({ ok: false, problem: "malformed" });
    expect(parseQuantity("-1", "en")).toEqual({ ok: false, problem: "malformed" });
    expect(parseQuantity("+1", "en")).toEqual({ ok: false, problem: "malformed" });
    expect(parseQuantity("1e3", "en")).toEqual({ ok: false, problem: "malformed" });
    expect(parseQuantity("1.", "en")).toEqual({ ok: false, problem: "malformed" });
    expect(parseQuantity(".5", "en")).toEqual({ ok: false, problem: "malformed" });
    expect(parseQuantity("1 5", "en")).toEqual({ ok: false, problem: "malformed" });
    expect(parseQuantity("abc", "en")).toEqual({ ok: false, problem: "malformed" });
    expect(parseQuantity("", "en")).toEqual({ ok: false, problem: "empty" });
  });

  it("refuses zero, excess precision and out-of-range amounts", () => {
    expect(parseQuantity("0", "en")).toEqual({ ok: false, problem: "not-positive" });
    expect(parseQuantity("0,000", "nl")).toEqual({ ok: false, problem: "not-positive" });
    expect(parseQuantity("1.2345", "en")).toEqual({ ok: false, problem: "precision" });
    expect(parseQuantity("1000001", "en")).toEqual({ ok: false, problem: "range" });
    expect(parseQuantity("1000000", "en")).toEqual({ ok: true, thousandths: 1_000_000_000 });
    expect(parseQuantity("123456789", "en")).toEqual({ ok: false, problem: "range" });
  });

  it("allows fractions only for units that support them", () => {
    expect(parseQuantity("2.5", "en", glasses)).toEqual({ ok: false, problem: "whole" });
    expect(parseQuantity("2", "en", glasses)).toEqual({ ok: true, thousandths: 2000 });
    expect(parseQuantity("2.5", "en", litres)).toEqual({ ok: true, thousandths: 2500 });
    expect(parseQuantity("0.25", "en", cups)).toEqual({ ok: true, thousandths: 250 });
  });
});

describe("exact decimal arithmetic", () => {
  it("adds 0.1 and 0.2 exactly", () => {
    expect(addThousandths([toThousandths(0.1), toThousandths(0.2)])).toBe(300);
    expect(addThousandths([toThousandths(0.1), toThousandths(0.2)])).toBe(toThousandths(0.3));
  });

  it("writes the decimal string the API accepts", () => {
    expect(thousandthsToDecimal(1500)).toBe("1.5");
    expect(thousandthsToDecimal(2_000_000)).toBe("2000");
    expect(thousandthsToDecimal(250)).toBe("0.25");
    expect(thousandthsToDecimal(1)).toBe("0.001");
  });

  it("caps only the bar, never the total", () => {
    expect(progressFraction(10_000, 8000)).toBe(1);
    expect(progressFraction(4000, 8000)).toBe(0.5);
    expect(progressFraction(0, 8000)).toBe(0);
  });
});

describe("unit conversions", () => {
  it("converts litres and millilitres exactly", () => {
    expect(convertThousandths(1500, litres, ml)).toEqual({ thousandths: 1_500_000, exact: true });
    expect(convertThousandths(1_500_000, ml, litres)).toEqual({ thousandths: 1500, exact: true });
    expect(convertThousandths(1, ml, litres)).toEqual({ thousandths: 0, exact: false });
  });

  it("converts time inside its dimension and flags inexact results", () => {
    expect(convertThousandths(90_000, minutes, hours)).toEqual({ thousandths: 1500, exact: true });
    expect(convertThousandths(20_000, minutes, hours)).toEqual({ thousandths: 333, exact: false });
  });

  it("never converts glasses, pages or custom labels", () => {
    expect(convertThousandths(1000, glasses, ml)).toBeNull();
    expect(convertThousandths(1000, cups, ml)).toBeNull();
    expect(convertThousandths(1000, minutes, ml)).toBeNull();
    expect(areUnitsConvertible(glasses, ml)).toBe(false);
    expect(areUnitsConvertible(cups, cups)).toBe(false);
    expect(areUnitsConvertible(ml, litres)).toBe(true);
  });
});

describe("tracking validation", () => {
  it("accepts a target with presets the unit allows", () => {
    expect(
      isValidNumericTracking({
        unit: "glasses",
        unitKind: "preset",
        target: 8000,
        quickAdds: [1000, 2000],
      }),
    ).toBe(true);
    expect(
      isValidNumericTracking({
        unit: "l",
        unitKind: "preset",
        target: 2500,
        quickAdds: [250, 500],
      }),
    ).toBe(true);
  });

  it("refuses what the database refuses", () => {
    const base = { unit: "glasses", unitKind: "preset", target: 8000, quickAdds: [1000] } as const;
    expect(isValidNumericTracking({ ...base, target: 0 })).toBe(false);
    expect(isValidNumericTracking({ ...base, target: 8500 })).toBe(false);
    expect(isValidNumericTracking({ ...base, quickAdds: [1000, 1000] })).toBe(false);
    expect(isValidNumericTracking({ ...base, quickAdds: [500] })).toBe(false);
    expect(
      isValidNumericTracking({ ...base, quickAdds: [1, 2, 3, 4, 5, 6].map((n) => n * 1000) }),
    ).toBe(false);
    expect(isValidNumericTracking({ ...base, unit: "furlongs" })).toBe(false);
    expect(isValidNumericTracking({ ...base, unit: "", unitKind: "custom" })).toBe(false);
    expect(isValidNumericTracking({ ...base, unit: "x".repeat(21), unitKind: "custom" })).toBe(
      false,
    );
  });

  it("offers presets that are valid for their unit", () => {
    for (const unit of ["glasses", "pages", "repetitions", "ml", "l", "min", "h", "m", "km"]) {
      const presets = suggestedQuickAdds({ unit, kind: "preset" });
      expect(presets.length).toBeGreaterThan(0);
      expect(
        isValidNumericTracking({ unit, unitKind: "preset", target: 10_000, quickAdds: presets }),
      ).toBe(true);
    }
    expect(suggestedQuickAdds(cups)).toEqual([]);
  });
});
