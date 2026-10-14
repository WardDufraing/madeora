import { acceptedNames, refusedNames } from "@/names/visible-name-cases";

import { effectiveHomeName, homeProfilePatchSchema, parseHomeProfile } from "./profile-schema";

describe("homeProfilePatchSchema", () => {
  it("normalizes names and colours and keeps only the fields sent", () => {
    expect(homeProfilePatchSchema.parse({ nickname: " Ali ", accentColor: "#2563EB" })).toEqual({
      nickname: "Ali",
      accentColor: "#2563eb",
    });
  });

  it("resets with null or an empty name", () => {
    expect(homeProfilePatchSchema.parse({ nickname: "  ", displayName: null })).toEqual({
      nickname: null,
      displayName: null,
    });
  });

  it.each(acceptedNames)("accepts %s as a nickname and Home name (shared list)", (_l, name) => {
    expect(homeProfilePatchSchema.safeParse({ nickname: name, displayName: name }).success).toBe(
      true,
    );
  });

  it.each(refusedNames)("refuses %s as a nickname and Home name (shared list)", (_l, name) => {
    expect(homeProfilePatchSchema.safeParse({ nickname: name }).success).toBe(false);
    expect(homeProfilePatchSchema.safeParse({ displayName: name }).success).toBe(false);
  });

  it.each([[{}], [{ userId: "x" }], [{ accentColor: "red" }], [{ nickname: "a".repeat(51) }]])(
    "refuses %j",
    (patch) => {
      expect(homeProfilePatchSchema.safeParse(patch).success).toBe(false);
    },
  );
});

describe("parseHomeProfile", () => {
  it("treats anything unexpected as inherit", () => {
    expect(
      parseHomeProfile({ nickname: "Al\u{200B}i", displayName: 7, accentColor: "#2563EB" }),
    ).toEqual({
      nickname: null,
      displayName: null,
      accentColor: null,
    });
    expect(
      parseHomeProfile({ nickname: "Ali", displayName: "Alice", accentColor: "#2563eb" }),
    ).toEqual({ nickname: "Ali", displayName: "Alice", accentColor: "#2563eb" });
  });
});

describe("effectiveHomeName", () => {
  it("prefers the nickname, then the Home name, then the global name", () => {
    expect(effectiveHomeName({ nickname: "Ali", displayName: "Alice B" }, "Alice")).toEqual({
      name: "Ali",
      source: "nickname",
    });
    expect(effectiveHomeName({ nickname: null, displayName: "Alice B" }, "Alice")).toEqual({
      name: "Alice B",
      source: "homeName",
    });
    expect(effectiveHomeName({ nickname: null, displayName: null }, "Alice")).toEqual({
      name: "Alice",
      source: "global",
    });
    expect(effectiveHomeName({ nickname: null, displayName: null }, null)).toEqual({
      name: null,
      source: "none",
    });
  });
});
