import { describe, expect, it } from "vitest";

import {
  formatQuantity,
  isValidQuantity,
  parseQuantity,
  quantityInput,
  scaleQuantity,
  totalMinutes,
  type Quantity,
} from "./quantity";

const q = (num: number, den: number, style: Quantity["style"]): Quantity => ({ num, den, style });

describe("parseQuantity", () => {
  it.each([
    ["2", q(2, 1, "decimal")],
    ["1.5", q(3, 2, "decimal")],
    ["1,5", q(3, 2, "decimal")],
    ["0.25", q(1, 4, "decimal")],
    ["0,125", q(1, 8, "decimal")],
    ["1/2", q(1, 2, "fraction")],
    ["1 1/2", q(3, 2, "fraction")],
    ["  2   3/4 ", q(11, 4, "fraction")],
    ["1/3", q(1, 3, "fraction")],
    ["4/8", q(1, 2, "fraction")],
    ["½", q(1, 2, "fraction")],
    ["1½", q(3, 2, "fraction")],
    ["2 ⅓", q(7, 3, "fraction")],
    ["100000", q(100000, 1, "decimal")],
  ])("reads %j", (input, expected) => {
    expect(parseQuantity(input)).toEqual(expected);
  });

  it.each([
    "",
    " ",
    "0",
    "0.0",
    "0/3",
    "-1",
    "1/0",
    "1.2345",
    "1,000.5",
    "1 3/2",
    "abc",
    "2 eggs",
    "100001",
    "1/1001",
    "1e3",
  ])("refuses %j", (input) => {
    expect(parseQuantity(input)).toBeNull();
  });

  it("round-trips through the editor's text", () => {
    for (const input of ["2", "1.5", "0.125", "1/3", "1 1/2", "7/8"]) {
      const parsed = parseQuantity(input);
      expect(parsed).not.toBeNull();
      expect(parseQuantity(quantityInput(parsed as Quantity))).toEqual(parsed);
    }
  });
});

describe("scaleQuantity", () => {
  it("scales 4 to 6 and 4 to 2 exactly", () => {
    expect(scaleQuantity(q(200, 1, "decimal"), 4, 6)).toEqual(q(300, 1, "decimal"));
    expect(scaleQuantity(q(3, 2, "decimal"), 4, 2)).toEqual(q(3, 4, "decimal"));
    expect(scaleQuantity(q(1, 3, "fraction"), 4, 6)).toEqual(q(1, 2, "fraction"));
  });

  it("keeps thirds exact: a third for three servings of one makes one", () => {
    expect(scaleQuantity(q(1, 3, "fraction"), 1, 3)).toEqual(q(1, 1, "fraction"));
  });

  it("never scales without a valid yield or selection", () => {
    expect(scaleQuantity(q(1, 1, "decimal"), null, 4)).toBeNull();
    expect(scaleQuantity(q(1, 1, "decimal"), 0, 4)).toBeNull();
    expect(scaleQuantity(q(1, 1, "decimal"), 4, 0)).toBeNull();
    expect(scaleQuantity(q(1, 1, "decimal"), 4, 1.5)).toBeNull();
    expect(scaleQuantity(q(1, 1, "decimal"), 4, 1000)).toBeNull();
  });
});

describe("formatQuantity", () => {
  it("shows whole numbers and exact decimals in the locale", () => {
    expect(formatQuantity(q(300, 1, "decimal"), "en")).toEqual({
      text: "300",
      approximate: false,
      exact: "300",
    });
    expect(formatQuantity(q(3, 2, "decimal"), "nl").text).toBe("1,5");
    expect(formatQuantity(q(1, 8, "decimal"), "en").text).toBe("0.125");
  });

  it("shows readable fractions as typed", () => {
    expect(formatQuantity(q(3, 2, "fraction"), "en").text).toBe("1 1/2");
    expect(formatQuantity(q(1, 3, "fraction"), "en").text).toBe("1/3");
  });

  it("rounds only for display, and says so", () => {
    const thirds = formatQuantity(q(7, 3, "decimal"), "en");
    expect(thirds).toEqual({ text: "2.33", approximate: true, exact: "7/3" });
    const odd = formatQuantity(q(13, 17, "fraction"), "nl");
    expect(odd).toEqual({ text: "0,76", approximate: true, exact: "13/17" });
  });
});

describe("isValidQuantity", () => {
  it("matches the database's rules", () => {
    expect(isValidQuantity(q(3, 2, "decimal"))).toBe(true);
    expect(isValidQuantity(q(6, 4, "decimal"))).toBe(false);
    expect(isValidQuantity(q(1, 1001, "fraction"))).toBe(false);
    expect(isValidQuantity(q(100_000_001, 1000, "decimal"))).toBe(false);
  });
});

describe("totalMinutes", () => {
  it("adds only when both parts are known", () => {
    expect(totalMinutes(10, 20)).toBe(30);
    expect(totalMinutes(0, 20)).toBe(20);
    expect(totalMinutes(null, 20)).toBeNull();
    expect(totalMinutes(10, null)).toBeNull();
  });
});
