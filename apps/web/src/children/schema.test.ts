import { describe, expect, it } from "vitest";

import { assignGuardianSchema, childAccessSchema, createChildSchema } from "./schema";

const ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

describe("child schemas", () => {
  it("accepts a quick creation with only the required fields", () => {
    const parsed = createChildSchema.parse({
      name: "  Mia ",
      primaryGuardianMembershipId: ID,
      ageBand: null,
      accentColor: "#16A34A",
      requestId: ID,
    });
    expect(parsed).toMatchObject({ name: "Mia", accentColor: "#16a34a", ageBand: null });
  });

  it("refuses an empty or disguised name, unknown fields and age bands", () => {
    const base = {
      primaryGuardianMembershipId: ID,
      ageBand: null,
      accentColor: "#16a34a",
      requestId: ID,
    };
    expect(createChildSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(createChildSchema.safeParse({ ...base, name: "Mi​a" }).success).toBe(false);
    expect(createChildSchema.safeParse({ ...base, name: "Mia", email: "x@y.z" }).success).toBe(
      false,
    );
    expect(createChildSchema.safeParse({ ...base, name: "Mia", ageBand: "18_plus" }).success).toBe(
      false,
    );
  });

  it("accepts only known capabilities as overrides", () => {
    const base = {
      preset: "child",
      confirmExpansion: false,
      expectedUpdatedAt: "2026-11-12T08:00:00.000+00:00",
    };
    expect(childAccessSchema.safeParse({ ...base, overrides: { viewPets: false } }).success).toBe(
      true,
    );
    expect(childAccessSchema.safeParse({ ...base, overrides: { admin: true } }).success).toBe(
      false,
    );
    expect(childAccessSchema.safeParse({ ...base, overrides: { viewPets: "yes" } }).success).toBe(
      false,
    );
    expect(childAccessSchema.safeParse({ ...base, preset: "adult", overrides: {} }).success).toBe(
      false,
    );
  });

  it("knows only the two guardian roles", () => {
    expect(
      assignGuardianSchema.safeParse({ role: "owner", guardianMembershipId: ID }).success,
    ).toBe(false);
  });
});
