import { describe, expect, it } from "vitest";

import {
  dueOnOrAfter,
  formatShoppingQuantity,
  isShoppingQuantity,
  isValidSchedule,
  nextDueDays,
  parseShoppingLine,
  parseShoppingLines,
  parseShoppingQuantity,
  shoppingNameKey,
  type ShoppingSchedule,
} from "./index";

describe("parseShoppingQuantity", () => {
  it("reads quantities as typed in nl and en, exactly", () => {
    expect(parseShoppingQuantity("2")).toBe("2");
    expect(parseShoppingQuantity("0,5")).toBe("0.5");
    expect(parseShoppingQuantity("0.5")).toBe("0.5");
    expect(parseShoppingQuantity(" 1,25 ")).toBe("1.25");
    expect(parseShoppingQuantity("0,125")).toBe("0.125");
    expect(parseShoppingQuantity("1000,5")).toBe("1000.5");
    expect(parseShoppingQuantity("007")).toBe("7");
    expect(parseShoppingQuantity("100000")).toBe("100000");
  });

  it("refuses zero, negatives, too many decimals, separators and words, never rounding", () => {
    for (const input of [
      "0",
      "0,000",
      "-1",
      "1.2345",
      "1.000.000",
      "1,000.5",
      // A thousands separator in one locale, three decimals in the other: never guessed.
      "1,000",
      "1.500",
      "1,500",
      "12.250",
      "1.250",
      "abc",
      "",
      "1e3",
      "100001",
    ]) {
      expect(parseShoppingQuantity(input), input).toBeNull();
    }
  });

  it("checks canonical strings as the API does", () => {
    expect(isShoppingQuantity("1.25")).toBe(true);
    expect(isShoppingQuantity("1.250")).toBe(false);
    expect(isShoppingQuantity("01")).toBe(false);
    expect(isShoppingQuantity("0")).toBe(false);
  });
});

describe("formatShoppingQuantity", () => {
  it("shows the stored value with the locale's decimal separator", () => {
    expect(formatShoppingQuantity("1.25", "nl")).toBe("1,25");
    expect(formatShoppingQuantity("1.25", "en")).toBe("1.25");
    expect(formatShoppingQuantity("1500", "en")).toBe("1,500");
    expect(formatShoppingQuantity("1500", "nl")).toBe("1.500");
    expect(formatShoppingQuantity("6", "nl")).toBe("6");
  });
});

describe("parseShoppingLines", () => {
  it("splits pasted text into trimmed, non-blank lines", () => {
    const { lines, overflow } = parseShoppingLines("melk\n\n  brood  \r\nkaas\n\neieren\n");
    expect(lines.map((line) => line.name)).toEqual(["melk", "brood", "kaas", "eieren"]);
    expect(overflow).toBe(0);
  });

  it("reports lines beyond the limit instead of dropping them silently", () => {
    const { lines, overflow } = parseShoppingLines("a\nb\nc", 2);
    expect(lines).toHaveLength(2);
    expect(overflow).toBe(1);
  });

  it("reads quantity and unit only when unambiguous", () => {
    expect(parseShoppingLine("500 g pasta")).toMatchObject({
      name: "pasta",
      quantity: "500",
      unit: "g",
    });
    expect(parseShoppingLine("500g pasta")).toMatchObject({
      name: "pasta",
      quantity: "500",
      unit: "g",
    });
    expect(parseShoppingLine("1,000 g sugar")).toMatchObject({
      name: "1,000 g sugar",
      quantity: null,
      unit: null,
      uncertain: true,
    });
    expect(parseShoppingLine("1.500 g suiker")).toMatchObject({ quantity: null, uncertain: true });
    expect(parseShoppingLine("1,5 kg aardappelen")).toMatchObject({
      name: "aardappelen",
      quantity: "1.5",
      unit: "kg",
    });
    expect(parseShoppingLine("6 appels")).toMatchObject({
      name: "appels",
      quantity: "6",
      unit: null,
    });
    expect(parseShoppingLine("2 L melk")).toMatchObject({ name: "melk", quantity: "2", unit: "l" });
  });

  it("keeps doubtful lines whole and flags them", () => {
    for (const line of ["2-3 uien", "½ kool", "melk 2", "500 g", "2 x 6 eieren", "0 appels"]) {
      const parsed = parseShoppingLine(line);
      expect(parsed, line).toMatchObject({
        name: line,
        quantity: null,
        unit: null,
        uncertain: true,
      });
    }
    expect(parseShoppingLine("pasta")).toMatchObject({ name: "pasta", uncertain: false });
  });
});

describe("shoppingNameKey", () => {
  it("ignores case, accents and spacing", () => {
    expect(shoppingNameKey(" Crème  Fraîche ")).toBe(shoppingNameKey("creme fraiche"));
    expect(shoppingNameKey("Melk")).not.toBe(shoppingNameKey("Melkpoeder"));
  });
});

describe("schedules", () => {
  const monthly = (day: number): ShoppingSchedule => ({
    frequency: "monthly",
    weekdays: null,
    monthDay: day,
    startOn: null,
  });

  it("puts the 31st on the last day of shorter months", () => {
    expect(dueOnOrAfter(monthly(31), "2027-02-01")).toBe("2027-02-28");
    expect(dueOnOrAfter(monthly(31), "2028-02-10")).toBe("2028-02-29");
    expect(dueOnOrAfter(monthly(31), "2027-03-01")).toBe("2027-03-31");
    expect(dueOnOrAfter(monthly(15), "2027-03-16")).toBe("2027-04-15");
    expect(nextDueDays(monthly(31), "2027-01-31")).toEqual([
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
    ]);
  });

  it("honours weekdays and a start date", () => {
    const weekly: ShoppingSchedule = {
      frequency: "weekly",
      weekdays: [1, 4],
      monthDay: null,
      startOn: null,
    };
    expect(dueOnOrAfter(weekly, "2027-03-30")).toBe("2027-04-01");
    expect(nextDueDays(weekly, "2027-03-29")).toEqual(["2027-04-01", "2027-04-05", "2027-04-08"]);
    expect(
      dueOnOrAfter(
        { frequency: "weekly", weekdays: [7], monthDay: null, startOn: "2027-04-20" },
        "2027-03-30",
      ),
    ).toBe("2027-04-25");
  });

  it("is daily from tomorrow, across a daylight-saving change", () => {
    const daily: ShoppingSchedule = {
      frequency: "daily",
      weekdays: null,
      monthDay: null,
      startOn: null,
    };
    expect(nextDueDays(daily, "2027-03-27")).toEqual(["2027-03-28", "2027-03-29", "2027-03-30"]);
  });

  it("validates schedules as the database does", () => {
    expect(
      isValidSchedule({ frequency: "weekly", weekdays: [], monthDay: null, startOn: null }),
    ).toBe(false);
    expect(
      isValidSchedule({ frequency: "weekly", weekdays: [1, 1], monthDay: null, startOn: null }),
    ).toBe(false);
    expect(isValidSchedule(monthly(32))).toBe(false);
    expect(
      isValidSchedule({ frequency: "daily", weekdays: [1], monthDay: null, startOn: null }),
    ).toBe(false);
    expect(isValidSchedule(monthly(31))).toBe(true);
  });
});
