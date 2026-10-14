import {
  createHomeSchema,
  homeNameSchema,
  homeSettingsPatchSchema,
  homeTimeZoneSchema,
} from "./schema";

const requestId = "0b7d6f5e-4c3b-4a29-8e1f-0a9b8c7d6e5f";

function messages(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

describe("homeNameSchema", () => {
  it("returns the normalized name", () => {
    expect(homeNameSchema.parse("  Cafe\u{301} Thuis ")).toBe("Caf\u{E9} Thuis");
  });

  it.each([
    ["", "nameRequired"],
    ["   ", "nameRequired"],
    ["a".repeat(51), "nameTooLong"],
    ["a".repeat(1001), "nameTooLong"],
    ["Thu\u{200B}is", "nameInvalid"],
    ["\u{2800}", "nameInvalid"],
  ])("refuses %j with %s", (value, message) => {
    expect(messages(homeNameSchema.safeParse(value))).toEqual([message]);
  });

  it("refuses something that is not text", () => {
    expect(messages(homeNameSchema.safeParse(42))).toEqual(["nameRequired"]);
  });
});

describe("homeTimeZoneSchema", () => {
  it("accepts and capitalizes a known zone", () => {
    expect(homeTimeZoneSchema.parse("europe/brussels")).toBe("Europe/Brussels");
  });

  it.each(["Mars/Olympus", "+02:00", "", "Europe/../etc"])("refuses %j", (value) => {
    expect(messages(homeTimeZoneSchema.safeParse(value))).toEqual(["timeZoneInvalid"]);
  });
});

describe("createHomeSchema", () => {
  it("accepts a name, a zone and a request id", () => {
    expect(
      createHomeSchema.parse({ name: " Thuis ", timeZone: "Europe/Brussels", requestId }),
    ).toEqual({ name: "Thuis", timeZone: "Europe/Brussels", requestId });
  });

  it("refuses unknown fields, so nobody can name an owner or an id", () => {
    expect(
      createHomeSchema.safeParse({
        name: "Thuis",
        timeZone: "UTC",
        requestId,
        ownerId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001",
      }).success,
    ).toBe(false);
  });

  it("needs a UUID request id", () => {
    expect(createHomeSchema.safeParse({ name: "Thuis", timeZone: "UTC" }).success).toBe(false);
    expect(
      createHomeSchema.safeParse({ name: "Thuis", timeZone: "UTC", requestId: "1" }).success,
    ).toBe(false);
  });
});

describe("homeSettingsPatchSchema", () => {
  it("accepts either field alone", () => {
    expect(homeSettingsPatchSchema.parse({ name: "Kot" })).toEqual({ name: "Kot" });
    expect(homeSettingsPatchSchema.parse({ timeZone: "UTC" })).toEqual({ timeZone: "UTC" });
  });

  it("refuses an empty change and unknown fields", () => {
    expect(homeSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(homeSettingsPatchSchema.safeParse({ role: "owner" }).success).toBe(false);
    expect(homeSettingsPatchSchema.safeParse({ name: "Kot", id: "x" }).success).toBe(false);
  });
});
