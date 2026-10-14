import { acceptedNames, refusedNames } from "@/names/visible-name-cases";

import {
  displayNameSchema,
  noPreferences,
  parseStoredPreferences,
  preferencesPatchSchema,
} from "./schema";

describe("displayNameSchema", () => {
  it("trims and NFC-normalizes the name", () => {
    expect(displayNameSchema.parse("  Amélie ")).toBe("Amélie");
    expect(displayNameSchema.parse("Ame\u0301lie")).toBe("Amélie");
  });

  it("turns an empty or blank name into no name", () => {
    expect(displayNameSchema.parse("")).toBeNull();
    expect(displayNameSchema.parse("   ")).toBeNull();
  });

  it("counts characters, not bytes or UTF-16 units, up to 50", () => {
    expect(displayNameSchema.parse("é".repeat(50))).toBe("é".repeat(50));
    expect(displayNameSchema.parse("👩\u200D👩\u200D👧".repeat(10))).toBe(
      "👩\u200D👩\u200D👧".repeat(10),
    );
    const result = displayNameSchema.safeParse("a".repeat(51));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("displayNameTooLong");
  });

  it.each([
    "Ali\nce",
    "Ali\u0000ce",
    "Ali\u0085ce",
    "Ali\u2028ce",
    "Ali\u200Fce",
    "Ali\u202Ece",
    "Ali\u2066ce",
  ])("refuses control and text-direction characters (%j)", (name) => {
    const result = displayNameSchema.safeParse(name);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("displayNameInvalid");
  });

  it.each(["\u200B", "\u3164\u3164", "\u00AD", "\u2060", "\u0301", "\uFE0F"])(
    "refuses a name with no visible character (%j)",
    (name) => {
      const result = displayNameSchema.safeParse(name);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("displayNameInvalid");
    },
  );

  // S11: display names follow the visible-name rule, held to the shared list (also run against
  // the database in tests/db/rls/visible-names.test.ts).
  it.each(acceptedNames)("accepts %s (shared name list)", (_label, name) => {
    expect(displayNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(refusedNames)("refuses %s (shared name list)", (_label, name) => {
    const result = displayNameSchema.safeParse(name);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("displayNameInvalid");
  });

  it("accepts what the database accepts: inner no-break spaces and emoji joiners", () => {
    // The same strings as tests/db/rls/user_preferences.test.sql, so app and database agree.
    expect(displayNameSchema.parse("Ali\u00A0ce \u{1F469}\u200D\u{1F467}")).toBe(
      "Ali\u00A0ce \u{1F469}\u200D\u{1F467}",
    );
  });

  it("keeps names in any script, including right-to-left ones", () => {
    expect(displayNameSchema.parse("שרה")).toBe("שרה");
    expect(displayNameSchema.parse("李小龍")).toBe("李小龍");
  });
});

describe("preferencesPatchSchema", () => {
  it("accepts a change to any subset of the preferences", () => {
    expect(
      preferencesPatchSchema.parse({
        displayName: " Sam ",
        locale: "nl",
        dateFormat: "dmy-dot",
        timeFormat: null,
        weekStart: "sunday",
        numberFormat: "space-comma",
        measurementSystem: "us-customary",
        timeZone: "europe/brussels",
      }),
    ).toEqual({
      displayName: "Sam",
      locale: "nl",
      dateFormat: "dmy-dot",
      timeFormat: null,
      weekStart: "sunday",
      numberFormat: "space-comma",
      measurementSystem: "us-customary",
      timeZone: "Europe/Brussels",
    });
    expect(preferencesPatchSchema.parse({ timeZone: null })).toEqual({ timeZone: null });
    expect(preferencesPatchSchema.parse({ accentColor: "#2563EB" })).toEqual({
      accentColor: "#2563eb",
    });
    expect(preferencesPatchSchema.parse({ accentColor: null })).toEqual({ accentColor: null });
    expect(preferencesPatchSchema.safeParse({ accentColor: "blue" }).success).toBe(false);
    expect(preferencesPatchSchema.parse({ displayName: null })).toEqual({ displayName: null });
  });

  it.each([
    [{}],
    [{ locale: "fr" }],
    [{ locale: null }],
    [{ dateFormat: "dd/mm/yyyy" }],
    [{ weekStart: "friday" }],
    [{ timeZone: "+05:00" }],
    [{ timeZone: "Nowhere/Land" }],
    [{ displayName: 42 }],
    [{ userId: "10000000-0000-4000-8000-000000000002" }],
    [{ locale: "en", user_id: "10000000-0000-4000-8000-000000000002" }],
    [null],
    [[]],
  ])("refuses %j", (patch) => {
    expect(preferencesPatchSchema.safeParse(patch).success).toBe(false);
  });
});

describe("parseStoredPreferences", () => {
  it("keeps valid stored values", () => {
    const stored = {
      displayName: "Sam",
      locale: "nl",
      dateFormat: "ymd-dash",
      timeFormat: "12h",
      weekStart: "saturday",
      numberFormat: "comma-dot",
      measurementSystem: "metric",
      timeZone: "Asia/Tokyo",
      accentColor: "#2563eb",
    };
    expect(parseStoredPreferences(stored)).toEqual(stored);
  });

  it("treats unexpected values as not chosen instead of failing", () => {
    expect(
      parseStoredPreferences({
        displayName: "Ali\u202Ece",
        locale: "fr",
        dateFormat: "weird",
        timeFormat: 12,
        weekStart: null,
        numberFormat: undefined,
        measurementSystem: "imperial",
        timeZone: "+01:00",
        accentColor: "#2563EB",
      }),
    ).toEqual(noPreferences);
  });
});
