import {
  FALLBACK_TIME_ZONE,
  normalizeTimeZone,
  resolveTimeZone,
  timeZoneChoices,
} from "./timezone";

describe("normalizeTimeZone", () => {
  it("accepts IANA zone names and returns their canonical spelling", () => {
    expect(normalizeTimeZone("Europe/Brussels")).toBe("Europe/Brussels");
    expect(normalizeTimeZone("europe/brussels")).toBe("Europe/Brussels");
    expect(normalizeTimeZone("America/Argentina/Buenos_Aires")).toBe(
      "America/Argentina/Buenos_Aires",
    );
    expect(normalizeTimeZone("UTC")).toBe("UTC");
  });

  it.each([
    "+05:00",
    "-0300",
    "Mars/Olympus_Mons",
    "Europe/Brussels; drop table x",
    "",
    "a".repeat(65),
    "../../etc/passwd",
    42,
    null,
    undefined,
  ])("refuses %j", (value) => {
    expect(normalizeTimeZone(value)).toBeNull();
  });
});

describe("resolveTimeZone", () => {
  it("uses the zone chosen on the account on every device", () => {
    expect(resolveTimeZone({ chosen: "Asia/Tokyo", device: "Europe/Brussels" })).toEqual({
      timeZone: "Asia/Tokyo",
      source: "chosen",
    });
  });

  it("otherwise uses this device's zone (Automatic)", () => {
    expect(resolveTimeZone({ chosen: null, device: "Europe/Brussels" })).toEqual({
      timeZone: "Europe/Brussels",
      source: "device",
    });
  });

  it("falls back to UTC, labelled as a fallback, before the device has reported a zone", () => {
    expect(resolveTimeZone({ chosen: null, device: undefined })).toEqual({
      timeZone: FALLBACK_TIME_ZONE,
      source: "fallback",
    });
  });

  it("ignores invalid saved values instead of failing", () => {
    expect(resolveTimeZone({ chosen: "Nowhere/Land", device: "+01:00" }).source).toBe("fallback");
    expect(resolveTimeZone({ chosen: "Nowhere/Land", device: "Europe/Brussels" }).source).toBe(
      "device",
    );
  });
});

describe("timeZoneChoices", () => {
  it("offers every known zone plus UTC and the extras, sorted and without duplicates", () => {
    const choices = timeZoneChoices(["Europe/Kyiv", "Europe/Brussels", null, "bogus"]);
    expect(choices).toContain("UTC");
    expect(choices).toContain("Europe/Kyiv");
    expect(choices).not.toContain("bogus");
    expect(new Set(choices).size).toBe(choices.length);
    expect([...choices].sort((a, b) => a.localeCompare(b, "en"))).toEqual(choices);
  });
});
