import {
  AMBIENT_AFTER_CHOICES,
  approveDisplaySchema,
  DEFAULT_AMBIENT_AFTER,
  homeDisplaySettingsSchema,
  isAmbientAfter,
  displayNameSchema,
  displayPairingAddress,
  formatPairingCode,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
} from "./schema";

describe("pairing codes", () => {
  it("accepts a code typed with lower case, spaces or dashes", () => {
    expect(normalizePairingCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizePairingCode(" abcd efgh ")).toBe("ABCDEFGH");
    expect(normalizePairingCode("ABCDEFGH")).toBe("ABCDEFGH");
  });

  it("refuses wrong lengths and characters that are never in a code", () => {
    expect(normalizePairingCode("ABCDEFG")).toBeNull();
    expect(normalizePairingCode("ABCDEFGHJ")).toBeNull();
    // 0, O, 1, I and L are left out so they cannot be confused.
    for (const lookalike of ["0", "O", "1", "I", "L"]) {
      expect(PAIRING_CODE_ALPHABET).not.toContain(lookalike);
      expect(normalizePairingCode(`ABCDEFG${lookalike}`)).toBeNull();
    }
    expect(normalizePairingCode("ABCD€FGH")).toBeNull();
  });

  it("shows a code in two groups of four", () => {
    expect(formatPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});

describe("display names", () => {
  it("trims names and refuses empty or too long ones", () => {
    expect(displayNameSchema.parse("  Keuken ")).toBe("Keuken");
    expect(displayNameSchema.safeParse("   ").success).toBe(false);
    expect(displayNameSchema.safeParse("x".repeat(41)).success).toBe(false);
    expect(displayNameSchema.safeParse("x".repeat(40)).success).toBe(true);
  });
});

describe("approval body", () => {
  it("needs the reviewed request, a valid code and a name, and nothing else", () => {
    const valid = {
      requestId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031",
      code: "abcd-efgh",
      name: "Hal",
    };
    expect(approveDisplaySchema.parse(valid)).toEqual({ ...valid, code: "ABCDEFGH" });
    expect(approveDisplaySchema.safeParse({ ...valid, homeId: "x" }).success).toBe(false);
    expect(approveDisplaySchema.safeParse({ ...valid, requestId: "nope" }).success).toBe(false);
  });
});

describe("display pairing address (S43-L5)", () => {
  it("uses this deployment's host and port, without the scheme", () => {
    expect(displayPairingAddress("https://madeora.studio", "/display")).toBe(
      "madeora.studio/display",
    );
    expect(displayPairingAddress("http://localhost:3000/", "/display")).toBe(
      "localhost:3000/display",
    );
    expect(displayPairingAddress("https://madeora-git-x.vercel.app/app", "/display")).toBe(
      "madeora-git-x.vercel.app/display",
    );
  });
});

describe("ambient timing (UX8a)", () => {
  it("offers one to thirty minutes, five by default", () => {
    expect(AMBIENT_AFTER_CHOICES).toEqual([60, 120, 300, 600, 900, 1800]);
    expect(DEFAULT_AMBIENT_AFTER).toBe(300);
    expect(isAmbientAfter(600)).toBe(true);
    expect(isAmbientAfter(45)).toBe(false);
    expect(homeDisplaySettingsSchema.safeParse({ ambientAfterSeconds: 900 }).success).toBe(true);
    expect(homeDisplaySettingsSchema.safeParse({ ambientAfterSeconds: 301 }).success).toBe(false);
    expect(homeDisplaySettingsSchema.safeParse({ ambientAfterSeconds: "300" }).success).toBe(false);
  });
});
