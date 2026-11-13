import {
  approveDisplaySchema,
  displayNameSchema,
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
