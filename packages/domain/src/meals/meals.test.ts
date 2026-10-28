import { describe, expect, it } from "vitest";

import {
  addDays,
  buildTransferRows,
  cadenceOccursOn,
  daysBetween,
  groupByCell,
  isMealDate,
  isoWeekday,
  isValidCadence,
  toShoppingQuantity,
  weekDates,
  weekStartOf,
  type TransferMeal,
} from "./index";

describe("meal dates", () => {
  it("accepts real dates only", () => {
    expect(isMealDate("2026-02-28")).toBe(true);
    expect(isMealDate("2028-02-29")).toBe(true);
    expect(isMealDate("2026-02-29")).toBe(false);
    expect(isMealDate("2026-13-01")).toBe(false);
    expect(isMealDate("1999-12-31")).toBe(false);
    expect(isMealDate("26-01-01")).toBe(false);
  });

  it("adds days across month, year and daylight-saving boundaries", () => {
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(daysBetween("2026-10-24", "2026-11-03")).toBe(10);
  });

  it("finds the week start for each preference", () => {
    // 2026-10-28 is a Wednesday.
    expect(isoWeekday("2026-10-28")).toBe(3);
    expect(weekStartOf("2026-10-28", "monday")).toBe("2026-10-26");
    expect(weekStartOf("2026-10-28", "sunday")).toBe("2026-10-25");
    expect(weekStartOf("2026-10-28", "saturday")).toBe("2026-10-24");
    expect(weekStartOf("2026-10-26", "monday")).toBe("2026-10-26");
    expect(weekStartOf("2026-10-25", "monday")).toBe("2026-10-19");
    expect(weekDates("2026-12-28")).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
  });
});

describe("repeat schedules", () => {
  it("validates cadences like the database", () => {
    expect(isValidCadence("daily", null)).toBe(true);
    expect(isValidCadence("daily", [1])).toBe(false);
    expect(isValidCadence("weekdays", [1, 3, 5])).toBe(true);
    expect(isValidCadence("weekdays", [])).toBe(false);
    expect(isValidCadence("weekdays", [1, 1])).toBe(false);
    expect(isValidCadence("weekdays", [0])).toBe(false);
    expect(isValidCadence("weekly", [5])).toBe(true);
    expect(isValidCadence("weekly", [1, 5])).toBe(false);
  });

  it("knows on which days a schedule occurs", () => {
    expect(cadenceOccursOn("daily", null, "2026-10-28")).toBe(true);
    expect(cadenceOccursOn("weekdays", [1, 3, 5], "2026-10-28")).toBe(true);
    expect(cadenceOccursOn("weekdays", [1, 3, 5], "2026-10-29")).toBe(false);
  });
});

describe("cells", () => {
  it("groups meals per date and slot and keeps every one of a conflict", () => {
    const cells = groupByCell([
      { date: "2026-10-28", slotId: "s1", id: "a" },
      { date: "2026-10-28", slotId: "s1", id: "b" },
      { date: "2026-10-28", slotId: "s2", id: "c" },
    ]);
    expect(cells.get("2026-10-28|s1")?.map((m) => m.id)).toEqual(["a", "b"]);
    expect(cells.get("2026-10-28|s2")).toHaveLength(1);
  });
});

describe("ingredient transfer rows", () => {
  const meal = (servings: number | null, yieldServings: number | null): TransferMeal => ({
    key: "e:1",
    date: "2026-10-28",
    slotId: "s1",
    status: "included",
    title: null,
    servings,
    recipe: {
      id: "r1",
      name: "Lasagne",
      servings: yieldServings,
      ingredients: [
        { position: 0, name: "Pasta", quantityNum: 500, quantityDen: 1, unit: "g", note: null },
        { position: 1, name: "Melk", quantityNum: 1, quantityDen: 2, unit: "l", note: "vol" },
        { position: 2, name: "Oregano", quantityNum: 1, quantityDen: 1, unit: "tsp", note: null },
        { position: 3, name: "Zout", quantityNum: null, quantityDen: null, unit: null, note: null },
        { position: 4, name: "Ui", quantityNum: 1, quantityDen: 3, unit: "piece", note: null },
      ],
    },
  });

  it("scales 4 to 6 servings exactly where it can and marks rounding", () => {
    const [result] = buildTransferRows([meal(6, 4)]);
    expect(result?.scaled).toBe(true);
    expect(
      result?.rows.map((row) => [
        row.name,
        row.quantity,
        row.unit,
        row.packagingUnit,
        row.approximate,
      ]),
    ).toEqual([
      ["Pasta", "750", "g", null, false],
      ["Melk", "0.75", "l", null, false],
      ["Oregano", "1.5", null, "tsp", false],
      ["Zout", null, null, null, false],
      ["Ui", "0.5", "piece", null, false],
    ]);
    expect(result?.rows[1]?.notes).toBe("vol");
  });

  it("keeps the stated amounts when the recipe has no yield or no servings were chosen", () => {
    for (const [servings, yieldServings] of [
      [6, null],
      [null, 4],
    ] as const) {
      const [result] = buildTransferRows([meal(servings, yieldServings)]);
      expect(result?.scaled).toBe(false);
      expect(result?.rows[0]?.quantity).toBe("500");
      expect(result?.rows[4]?.quantity).toBe("0.333");
      expect(result?.rows[4]?.approximate).toBe(true);
    }
  });

  it("leaves out custom and unavailable meals", () => {
    const rows = buildTransferRows([
      { ...meal(2, 2), key: "e:2", status: "custom", recipe: null, title: "Pizza" },
      { ...meal(2, 2), key: "e:3", status: "unavailable", recipe: null },
    ]);
    expect(rows).toEqual([]);
  });

  it("writes shopping quantities with at most three decimals", () => {
    expect(toShoppingQuantity({ num: 2, den: 3, style: "fraction" })).toEqual({
      value: "0.667",
      approximate: true,
    });
    expect(toShoppingQuantity({ num: 5, den: 2, style: "decimal" })).toEqual({
      value: "2.5",
      approximate: false,
    });
    expect(toShoppingQuantity({ num: 1, den: 3000, style: "fraction" })).toEqual({
      value: null,
      approximate: true,
    });
    expect(toShoppingQuantity({ num: 200_001, den: 2, style: "decimal" }).value).toBeNull();
  });
});
