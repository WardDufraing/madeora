import {
  CUSTOM_UNIT,
  defaultTrackingDraft,
  draftFromTracking,
  localizedDecimal,
  trackingFromDraft,
  withUnit,
  type TrackingDraft,
} from "./tracking-draft";

// S29: what a form holds while it is edited, and how it is read in nl and en.

const numeric = (overrides: Partial<TrackingDraft> = {}): TrackingDraft => ({
  numeric: true,
  unit: "ml",
  custom: "",
  target: "2000",
  quickAdds: ["250", "500"],
  ...overrides,
});

describe("reading a tracking draft", () => {
  it("is complete once unless numeric", () => {
    expect(trackingFromDraft(defaultTrackingDraft("en"), "en")).toEqual({
      ok: true,
      tracking: null,
    });
  });

  it("reads decimals with the separator of the person's locale", () => {
    const en = trackingFromDraft(numeric({ unit: "l", target: "1.5", quickAdds: ["0.25"] }), "en");
    const nl = trackingFromDraft(numeric({ unit: "l", target: "1,5", quickAdds: ["0,25"] }), "nl");
    const expected = {
      ok: true,
      tracking: { target: "1.5", unit: "l", unitKind: "preset", quickAdds: ["0.25"] },
    };
    expect(en).toEqual(expected);
    expect(nl).toEqual(expected);
  });

  it("refuses the other locale's separator and thousands separators instead of guessing", () => {
    const comma = trackingFromDraft(numeric({ unit: "l", target: "1,5" }), "en");
    expect(comma).toMatchObject({ ok: false, errors: { target: "separator" } });
    const point = trackingFromDraft(numeric({ unit: "l", target: "1.5" }), "nl");
    expect(point).toMatchObject({ ok: false, errors: { target: "separator" } });
    // 1.500 is not 1500 in Dutch, and 1,500 is not 1.5 in English.
    expect(trackingFromDraft(numeric({ target: "1.500" }), "nl")).toMatchObject({ ok: false });
    expect(trackingFromDraft(numeric({ target: "1,500" }), "en")).toMatchObject({ ok: false });
    expect(trackingFromDraft(numeric({ target: "1.234,5" }), "nl")).toMatchObject({
      ok: false,
      errors: { target: "malformed" },
    });
  });

  it("explains an empty, zero, too precise, too large or fractional target", () => {
    const problem = (target: string, unit = "ml") => {
      const result = trackingFromDraft(numeric({ target, unit }), "en");
      return result.ok ? null : result.errors.target;
    };
    expect(problem("")).toBe("empty");
    expect(problem("0")).toBe("not-positive");
    expect(problem("1.2345")).toBe("precision");
    expect(problem("1000001")).toBe("range");
    expect(problem("-5")).toBe("malformed");
    expect(problem("1e3")).toBe("malformed");
    expect(problem("7.5", "glasses")).toBe("whole");
    expect(problem("8", "glasses")).toBeNull();
  });

  it("needs a custom unit label of 1 to 20 characters", () => {
    const missing = trackingFromDraft(numeric({ unit: CUSTOM_UNIT, custom: "  " }), "en");
    expect(missing).toMatchObject({ ok: false, errors: { unit: "required" } });
    const long = trackingFromDraft(numeric({ unit: CUSTOM_UNIT, custom: "x".repeat(21) }), "en");
    expect(long).toMatchObject({ ok: false, errors: { unit: "tooLong" } });
    expect(trackingFromDraft(numeric({ unit: CUSTOM_UNIT, custom: " cups " }), "en")).toEqual({
      ok: true,
      tracking: { target: "2000", unit: "cups", unitKind: "custom", quickAdds: ["250", "500"] },
    });
  });

  it("flags a duplicate preset and ignores blank ones", () => {
    const duplicate = trackingFromDraft(numeric({ quickAdds: ["250", "250.0"] }), "en");
    expect(duplicate).toMatchObject({ ok: false, errors: { quickAdds: [undefined, "duplicate"] } });
    expect(trackingFromDraft(numeric({ quickAdds: ["250", "", "  "] }), "en")).toMatchObject({
      ok: true,
      tracking: { quickAdds: ["250"] },
    });
    const tooMany = trackingFromDraft(numeric({ quickAdds: ["1", "2", "3", "4", "5", "6"] }), "en");
    expect(tooMany.ok).toBe(false);
  });
});

describe("a draft and its units", () => {
  it("restarts the presets for another unit and never converts them", () => {
    const water = withUnit(numeric(), "l", "", "nl");
    expect(water.quickAdds).toEqual(["0,25", "0,5"]);
    expect(withUnit(numeric(), "glasses", "", "en").quickAdds).toEqual(["1", "2"]);
    expect(withUnit(numeric(), CUSTOM_UNIT, "cups", "en").quickAdds).toEqual([]);
  });

  it("writes and reads a tracking in the person's locale", () => {
    const tracking = {
      effectiveOn: "2026-11-01",
      mode: "numeric" as const,
      target: 1.5,
      unit: "l",
      unitKind: "preset" as const,
      quickAdds: [0.25, 0.5],
    };
    expect(draftFromTracking(tracking, "nl")).toMatchObject({
      numeric: true,
      unit: "l",
      target: "1,5",
      quickAdds: ["0,25", "0,5"],
    });
    expect(draftFromTracking(tracking, "en").target).toBe("1.5");
    expect(draftFromTracking({ ...tracking, mode: "once", target: null }, "en").numeric).toBe(
      false,
    );
    const custom = draftFromTracking({ ...tracking, unit: "cups", unitKind: "custom" }, "en");
    expect(custom).toMatchObject({ unit: CUSTOM_UNIT, custom: "cups" });
  });

  it("formats thousandths for the locale", () => {
    expect(localizedDecimal(1500, "nl")).toBe("1,5");
    expect(localizedDecimal(1500, "en")).toBe("1.5");
    expect(localizedDecimal(2_000_000, "en")).toBe("2000");
  });
});
