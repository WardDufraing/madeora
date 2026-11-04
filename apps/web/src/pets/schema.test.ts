// S31: the pets contract and the formatting helpers. The database checks everything again
// (tests/db/rls/pets.test.sql).
import { parseDecimal, petAge } from "./format";
import {
  createPetSchema,
  medicalDetailsSchema,
  medicalEntrySchema,
  petDateSchema,
  petProfileSchema,
} from "./schema";
import { checkPetAttachment, checkPetPhoto } from "./upload";

const ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a0";

function issues(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) {
  return result.success
    ? []
    : (result.error?.issues ?? []).map((i) => `${String(i.path[0])}:${i.message}`);
}

describe("a pet starts with only its name", () => {
  it("trims the name and refuses an empty, too long or multi-line one", () => {
    expect(createPetSchema.parse({ id: ID, homeId: ID, name: "  Miso " }).name).toBe("Miso");
    expect(createPetSchema.safeParse({ id: ID, homeId: ID, name: "   " }).success).toBe(false);
    expect(createPetSchema.safeParse({ id: ID, homeId: ID, name: "x".repeat(81) }).success).toBe(
      false,
    );
    expect(createPetSchema.safeParse({ id: ID, homeId: ID, name: "Mi\nso" }).success).toBe(false);
  });
});

describe("the basic profile", () => {
  it("takes only the name; every other field is not entered", () => {
    const profile = petProfileSchema.parse({ name: "Miso" });
    expect(profile).toMatchObject({ species: null, breed: null, weight: null, unknown: [] });
  });

  it("keeps Unknown apart from empty, and refuses a value marked Unknown", () => {
    expect(petProfileSchema.parse({ name: "Miso", breed: " ", unknown: ["breed"] }).breed).toBe(
      null,
    );
    expect(
      issues(petProfileSchema.safeParse({ name: "Miso", breed: "Maine Coon", unknown: ["breed"] })),
    ).toContain("unknown:invalid");
    expect(petProfileSchema.safeParse({ name: "Miso", unknown: ["breed", "breed"] }).success).toBe(
      false,
    );
  });

  it("takes a birth date or an approximate age, never both, and never an age of zero", () => {
    expect(
      issues(petProfileSchema.safeParse({ name: "M", birthDate: "2022-01-01", ageYears: 3 })),
    ).toContain("ageYears:birthOrAge");
    expect(issues(petProfileSchema.safeParse({ name: "M", ageYears: 0, ageMonths: 0 }))).toContain(
      "ageYears:invalid",
    );
    expect(petProfileSchema.safeParse({ name: "M", ageMonths: 12 }).success).toBe(false);
    expect(petProfileSchema.safeParse({ name: "M", ageRecordedOn: "2026-01-01" }).success).toBe(
      false,
    );
    expect(
      petProfileSchema.safeParse({ name: "M", ageYears: 3, ageRecordedOn: "2026-01-01" }).success,
    ).toBe(true);
  });

  it("takes a weight with its unit, up to 3 decimals and 2000", () => {
    expect(petProfileSchema.safeParse({ name: "M", weight: 4.125, weightUnit: "kg" }).success).toBe(
      true,
    );
    expect(issues(petProfileSchema.safeParse({ name: "M", weight: 4 }))).toContain(
      "weight:weightUnit",
    );
    expect(
      petProfileSchema.safeParse({ name: "M", weight: 4.1234, weightUnit: "kg" }).success,
    ).toBe(false);
    expect(petProfileSchema.safeParse({ name: "M", weight: 0, weightUnit: "kg" }).success).toBe(
      false,
    );
    expect(petProfileSchema.safeParse({ name: "M", weight: 2001, weightUnit: "lb" }).success).toBe(
      false,
    );
  });

  it("takes a custom species label only for Other, and checks the vet's phone and email", () => {
    expect(
      petProfileSchema.safeParse({ name: "M", species: "dog", speciesLabel: "x" }).success,
    ).toBe(false);
    expect(
      petProfileSchema.safeParse({ name: "M", species: "other", speciesLabel: "Axolotl" }).success,
    ).toBe(true);
    expect(issues(petProfileSchema.safeParse({ name: "M", vetPhone: "call me" }))).toContain(
      "vetPhone:invalid",
    );
    expect(petProfileSchema.safeParse({ name: "M", vetPhone: "+32 (0)9 123 45 67" }).success).toBe(
      true,
    );
    expect(issues(petProfileSchema.safeParse({ name: "M", vetEmail: "vet@" }))).toContain(
      "vetEmail:invalid",
    );
  });

  it("takes only dates that exist", () => {
    expect(petDateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(petDateSchema.safeParse("2026-02-29").success).toBe(false);
    expect(petDateSchema.safeParse("2026-1-5").success).toBe(false);
  });
});

describe("the sensitive details", () => {
  it("records allergies as None, apart from empty and Unknown", () => {
    const details = medicalDetailsSchema.parse({ allergies: "", none: ["allergies"] });
    expect(details).toMatchObject({ allergies: null, none: ["allergies"], unknown: [] });
    expect(
      medicalDetailsSchema.safeParse({ allergies: "Chicken", none: ["allergies"] }).success,
    ).toBe(false);
    expect(
      medicalDetailsSchema.safeParse({ none: ["allergies"], unknown: ["allergies"] }).success,
    ).toBe(false);
    expect(medicalDetailsSchema.safeParse({ none: ["microchip"] }).success).toBe(false);
  });
});

describe("a medical entry", () => {
  it("needs a type and a date, and a follow-up on or after it", () => {
    expect(medicalEntrySchema.safeParse({ type: "vaccination" }).success).toBe(false);
    expect(medicalEntrySchema.safeParse({ type: "vaccination", date: "2026-10-20" }).success).toBe(
      true,
    );
    expect(
      issues(
        medicalEntrySchema.safeParse({
          type: "test",
          date: "2026-10-20",
          followUpDate: "2026-10-19",
        }),
      ),
    ).toContain("followUpDate:beforeEvent");
    expect(medicalEntrySchema.safeParse({ type: "grooming", date: "2026-10-20" }).success).toBe(
      false,
    );
  });
});

describe("files", () => {
  it("takes images and PDF documents up to 10 MB, and only images as a photo", () => {
    expect(checkPetAttachment({ name: "scan.pdf", type: "application/pdf", size: 10 })).toEqual({
      type: "application/pdf",
    });
    expect(checkPetAttachment({ name: "notes.txt", type: "text/plain", size: 10 })).toEqual({
      problem: "type",
    });
    expect(
      checkPetAttachment({ name: "big.pdf", type: "application/pdf", size: 10 * 1024 * 1024 + 1 }),
    ).toEqual({ problem: "size" });
    expect(checkPetPhoto({ type: "image/webp", size: 10 })).toEqual({ type: "image/webp" });
    expect(checkPetPhoto({ type: "application/pdf", size: 10 })).toEqual({ problem: "type" });
  });
});

describe("formatting", () => {
  it("counts an age from the birth date, never past today", () => {
    const pet = { birthDate: "2022-03-15", ageYears: null, ageMonths: null, ageRecordedOn: null };
    expect(petAge(pet, "2026-03-14")).toEqual({ years: 3, months: 11, approximate: false });
    expect(petAge(pet, "2026-03-15")).toEqual({ years: 4, months: 0, approximate: false });
  });

  it("keeps counting an approximate age from the day it was recorded", () => {
    const pet = { birthDate: null, ageYears: 3, ageMonths: 2, ageRecordedOn: "2026-01-10" };
    expect(petAge(pet, "2026-11-10")).toEqual({ years: 4, months: 0, approximate: true });
    expect(petAge({ ...pet, ageYears: null, ageRecordedOn: null }, "2026-11-10")).toBeNull();
  });

  it("reads a decimal as people type it", () => {
    expect(parseDecimal("28,4")).toBe(28.4);
    expect(parseDecimal(" 4.125 ")).toBe(4.125);
    expect(parseDecimal("4.1234")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
  });
});
