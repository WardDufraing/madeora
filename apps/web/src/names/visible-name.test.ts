import { nameProblem, normalizeName } from "./visible-name";
import { acceptedNames, refusedNames } from "./visible-name-cases";

describe("normalizeName", () => {
  it("normalizes to NFC and trims every kind of whitespace", () => {
    expect(normalizeName("  Cafe\u{301} ")).toBe("Caf\u{E9}");
    expect(normalizeName("\u{3000}Thuis\u{A0}\u{2003}")).toBe("Thuis");
    expect(normalizeName("\u{FEFF}Thuis")).toBe("Thuis");
  });
});

describe("nameProblem", () => {
  it.each(acceptedNames)("accepts %s", (_label, name) => {
    expect(nameProblem(normalizeName(name), 50)).toBeNull();
  });

  it.each(refusedNames)("refuses %s", (_label, name) => {
    expect(nameProblem(normalizeName(name), 50)).toBe("invalid");
  });

  it("counts characters, not UTF-16 units, against the limit", () => {
    expect(nameProblem("a".repeat(51), 50)).toBe("tooLong");
    expect(nameProblem("\u{1F3E0}".repeat(51), 50)).toBe("tooLong");
  });
});
