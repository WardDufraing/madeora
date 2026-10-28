import { describe, expect, it } from "vitest";

import type { ShoppingListDetail } from "./api";
import {
  amountText,
  quantityInput,
  shoppingListPath,
  shoppingPath,
  shoppingRights,
} from "./format";
import { itemFieldsSchema, scheduleSchema, widgetQuerySchema } from "./schema";

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";

describe("shopping paths", () => {
  it("keeps each context's lists under its own address", () => {
    expect(shoppingPath(null)).toBe("/shopping");
    expect(shoppingPath(HOME, "archived")).toBe(`/homes/${HOME}/shopping?view=archived`);
    expect(shoppingListPath(null, LIST, "add-several")).toBe(`/shopping/${LIST}/add-several`);
  });
});

describe("quantities on screen", () => {
  const unit = (value: string) => value;
  it("shows and edits the stored value in the viewer's locale, never rounding", () => {
    expect(amountText("1.25", "kg", "nl", unit)).toBe("1,25 kg");
    expect(amountText("1500", null, "en", unit)).toBe("1,500");
    expect(amountText(null, null, "en", unit)).toBeNull();
    expect(quantityInput("1500.125", "nl")).toBe("1500,125");
    expect(quantityInput("0.5", "en")).toBe("0.5");
  });
});

describe("rights for the interface", () => {
  const base = { archived: false, access: "edit" } as Pick<
    ShoppingListDetail,
    "archived" | "access"
  >;
  const rights = (overrides: Partial<typeof base>) =>
    shoppingRights({ ...base, ...overrides } as ShoppingListDetail);
  it("follows the list's access, and makes an archived list read only", () => {
    expect(rights({})).toEqual({ manage: false, edit: true, check: true });
    expect(rights({ access: "check" })).toEqual({ manage: false, edit: false, check: true });
    expect(rights({ access: "view" })).toEqual({ manage: false, edit: false, check: false });
    expect(rights({ access: "manage", archived: true })).toEqual({
      manage: true,
      edit: false,
      check: false,
    });
  });
});

describe("shopping schemas", () => {
  it("needs a quantity for a unit and keeps quantities as strings", () => {
    expect(itemFieldsSchema.safeParse({ name: "Melk", unit: "l" }).success).toBe(false);
    expect(itemFieldsSchema.parse({ name: " Melk ", quantity: "1.5", unit: "l" })).toMatchObject({
      name: "Melk",
      quantity: "1.5",
    });
    expect(itemFieldsSchema.safeParse({ name: "Melk", quantity: 1.5 }).success).toBe(false);
  });

  it("accepts only well-formed schedules", () => {
    expect(
      scheduleSchema.safeParse({
        frequency: "weekly",
        weekdays: [8],
        monthDay: null,
        startOn: null,
      }).success,
    ).toBe(false);
    expect(
      scheduleSchema.safeParse({
        frequency: "monthly",
        weekdays: null,
        monthDay: 31,
        startOn: "2027-02-30",
      }).success,
    ).toBe(false);
    expect(
      scheduleSchema.safeParse({
        frequency: "monthly",
        weekdays: null,
        monthDay: 31,
        startOn: null,
      }).success,
    ).toBe(true);
  });

  it("limits a widget to five distinct lists", () => {
    const ids = Array.from({ length: 6 }, (_, index) => `${LIST.slice(0, -1)}${String(index)}`);
    expect(widgetQuerySchema.safeParse({ homeId: null, listIds: ids, limit: 5 }).success).toBe(
      false,
    );
    expect(
      widgetQuerySchema.safeParse({ homeId: null, listIds: ids.slice(0, 5), limit: 15 }).success,
    ).toBe(true);
  });
});
