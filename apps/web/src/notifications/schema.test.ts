import { describe, expect, it } from "vitest";

import {
  markReadSchema,
  preferenceSchema,
  quietHoursSchema,
  resetPreferenceSchema,
  resetQuietHoursSchema,
} from "./schema";

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

describe("preferenceSchema", () => {
  it("accepts the account's defaults and a Home override", () => {
    expect(
      preferenceSchema.safeParse({
        homeId: null,
        category: "invitations",
        channel: "email",
        enabled: true,
      }).success,
    ).toBe(true);
    expect(
      preferenceSchema.safeParse({
        homeId: HOME_ID,
        category: "invitations",
        channel: "in_app",
        enabled: false,
      }).success,
    ).toBe(true);
  });

  it.each([
    { homeId: null, category: "security", channel: "email", enabled: false },
    { homeId: null, category: "invitations", channel: "sms", enabled: true },
    { homeId: "home", category: "invitations", channel: "email", enabled: true },
    { homeId: null, category: "invitations", channel: "email", enabled: "yes" },
    { homeId: null, category: "invitations", channel: "email", enabled: true, userId: "x" },
    { category: "invitations", channel: "email", enabled: true },
  ])("refuses %j", (body) => {
    expect(preferenceSchema.safeParse(body).success).toBe(false);
  });

  it("resets without an enabled value", () => {
    expect(
      resetPreferenceSchema.safeParse({
        homeId: HOME_ID,
        category: "invitations",
        channel: "email",
      }).success,
    ).toBe(true);
    expect(
      resetPreferenceSchema.safeParse({
        homeId: HOME_ID,
        category: "invitations",
        channel: "email",
        enabled: true,
      }).success,
    ).toBe(false);
  });
});

describe("quietHoursSchema", () => {
  const valid = {
    homeId: null,
    enabled: true,
    start: "22:00",
    end: "07:00",
    timeZone: "Europe/Brussels",
  };

  it("accepts an overnight window in a real zone", () => {
    expect(quietHoursSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    { ...valid, start: "07:00" },
    { ...valid, start: "24:00" },
    { ...valid, end: "7:00" },
    { ...valid, start: "22:00:00" },
    { ...valid, timeZone: "Mars/Olympus" },
    { ...valid, timeZone: "+02:00" },
    { ...valid, homeId: "x" },
  ])("refuses %j", (body) => {
    expect(quietHoursSchema.safeParse(body).success).toBe(false);
  });

  it("resets one scope", () => {
    expect(resetQuietHoursSchema.safeParse({ homeId: HOME_ID }).success).toBe(true);
    expect(resetQuietHoursSchema.safeParse({}).success).toBe(false);
  });
});

describe("markReadSchema", () => {
  it("takes up to 100 ids, or everything", () => {
    expect(markReadSchema.safeParse({ ids: [HOME_ID] }).success).toBe(true);
    expect(markReadSchema.safeParse({ all: true }).success).toBe(true);
    expect(markReadSchema.safeParse({ ids: Array(101).fill(HOME_ID) }).success).toBe(false);
    expect(markReadSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(markReadSchema.safeParse({ all: false }).success).toBe(false);
    expect(markReadSchema.safeParse({ ids: [HOME_ID], all: true }).success).toBe(false);
  });
});
