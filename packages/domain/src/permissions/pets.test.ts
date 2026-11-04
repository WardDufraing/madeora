import { describe, expect, it } from "vitest";

import type { HomeMembershipFacts } from "./home";
import {
  canChangeMedicalAccess,
  decidePetAction,
  decidePetCareAction,
  effectiveMedicalLevel,
  petCareActions,
  type PetCareAction,
  petPermissions,
  type PetFacts,
  type PetMedicalLevel,
} from "./pets";

const membership = (
  role: HomeMembershipFacts["role"],
  granted: readonly string[] = [],
  homeId = "h1",
): HomeMembershipFacts => ({
  homeId,
  role,
  grantedCapabilities: new Set(granted) as HomeMembershipFacts["grantedCapabilities"],
});
const facts = (
  member: HomeMembershipFacts | null,
  medicalLevel: PetMedicalLevel | null = null,
): PetFacts => ({ homeId: "h1", membership: member, medicalLevel });

describe("pet permissions", () => {
  it("lets every member see pets, but only pet managers manage them", () => {
    expect(petPermissions(facts(membership("member")))).toEqual({
      "pets.view": true,
      "pets.manage": false,
      "pets.medical.view": false,
      "pets.medical.manage": false,
    });
    expect(decidePetAction(facts(membership("administrator")), "pets.manage").allowed).toBe(false);
    expect(
      decidePetAction(facts(membership("administrator", ["manageHomePets"])), "pets.manage")
        .allowed,
    ).toBe(true);
  });

  it("never derives medical access from pet management or from the grant capability", () => {
    const admin = membership("administrator", ["manageHomePets", "managePetMedicalAccess"]);
    expect(petPermissions(facts(admin))["pets.medical.view"]).toBe(false);
    expect(petPermissions(facts(admin))["pets.medical.manage"]).toBe(false);
  });

  it("separates medical view from medical manage", () => {
    expect(petPermissions(facts(membership("member"), "view"))).toMatchObject({
      "pets.medical.view": true,
      "pets.medical.manage": false,
    });
    expect(petPermissions(facts(membership("member"), "manage"))).toMatchObject({
      "pets.medical.view": true,
      "pets.medical.manage": true,
      "pets.manage": false,
    });
  });

  it("gives the Owner medical manage without a grant", () => {
    expect(effectiveMedicalLevel(facts(membership("owner")))).toBe("manage");
  });

  it("refuses a non-member and another Home's membership, whatever level is claimed", () => {
    expect(decidePetAction(facts(null, "manage"), "pets.view")).toEqual({
      allowed: false,
      reason: "not-member",
    });
    const elsewhere = facts(membership("owner", [], "h2"), "manage");
    expect(petPermissions(elsewhere)["pets.medical.view"]).toBe(false);
    expect(effectiveMedicalLevel(elsewhere)).toBeNull();
  });

  it("lets only the Owner and granted Administrators change others' medical access", () => {
    const other = { role: "member" as const, isSelf: false };
    expect(canChangeMedicalAccess("h1", membership("owner"), other)).toBe(true);
    expect(canChangeMedicalAccess("h1", membership("administrator"), other)).toBe(false);
    expect(
      canChangeMedicalAccess("h1", membership("administrator", ["managePetMedicalAccess"]), other),
    ).toBe(true);
    expect(canChangeMedicalAccess("h1", membership("member"), other)).toBe(false);
    expect(
      canChangeMedicalAccess("h1", membership("administrator", ["managePetMedicalAccess"]), {
        role: "administrator",
        isSelf: true,
      }),
    ).toBe(false);
    expect(
      canChangeMedicalAccess("h1", membership("administrator", ["managePetMedicalAccess"]), {
        role: "owner",
        isSelf: false,
      }),
    ).toBe(false);
    expect(canChangeMedicalAccess("h2", membership("owner"), other)).toBe(false);
  });
});

describe("pet-care permissions", () => {
  const allowed = (f: PetFacts, care: Parameters<typeof decidePetCareAction>[1]) =>
    petCareActions.filter((action: PetCareAction) => decidePetCareAction(f, care, action).allowed);

  it("lets every member see and complete care, and read ordinary texts", () => {
    expect(allowed(facts(membership("member")), { medical: false })).toEqual([
      "care.view",
      "care.readTexts",
      "care.complete",
    ]);
  });

  it("hides medical texts without medical view, also from pet managers", () => {
    const manager = facts(membership("administrator", ["manageHomePets"]));
    expect(allowed(manager, { medical: true })).toEqual([
      "care.view",
      "care.complete",
      "care.manage",
      "care.skip",
      "care.reopen",
    ]);
    expect(allowed(manager, { medical: false })).toContain("care.edit");
    expect(
      allowed(facts(membership("administrator", ["manageHomePets"]), "manage"), { medical: true }),
    ).toEqual([...petCareActions]);
  });

  it("lets a responsible member skip, and whoever recorded it reopen and correct", () => {
    expect(
      allowed(facts(membership("member")), {
        medical: false,
        responsible: true,
        recordedBySelf: true,
      }),
    ).toEqual([
      "care.view",
      "care.readTexts",
      "care.complete",
      "care.skip",
      "care.correct",
      "care.reopen",
    ]);
    expect(
      decidePetCareAction(
        facts(membership("member")),
        { medical: true, recordedBySelf: true },
        "care.correct",
      ).allowed,
    ).toBe(false);
  });

  it("allows nothing outside the Home", () => {
    expect(allowed(facts(membership("owner", [], "h2")), { medical: false })).toEqual([]);
    expect(allowed(facts(null), { medical: false })).toEqual([]);
  });
});
