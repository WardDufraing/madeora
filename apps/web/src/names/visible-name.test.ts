import { nameProblem, normalizeName } from "./visible-name";

// Invisible characters are written as escapes, never literally (S07 review L1).
const accepted: readonly (readonly [string, string])[] = [
  ["a plain name", "Thuis"],
  ["accented letters", "Famille Dupr\u{E9}"],
  ["Chinese", "\u{5BB6}"],
  ["Arabic", "\u{62E}\u{627}\u{646}\u{647}"],
  [
    "Persian with a zero-width non-joiner between letters",
    "\u{645}\u{6CC}\u{200C}\u{62E}\u{648}\u{627}\u{647}\u{645}",
  ],
  ["Hindi with combining vowel signs", "\u{918}\u{930}"],
  ["an emoji family (zero-width joiners)", "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"],
  ["an emoji with a variation selector", "Thuis \u{2764}\u{FE0F}"],
  ["a joiner after a variation selector", "\u{1F441}\u{FE0F}\u{200D}\u{1F5E8}\u{FE0F}"],
  [
    "the England flag (tag sequence)",
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} Home",
  ],
  ["a no-break space inside", "De\u{A0}Bron"],
  ["an ideographic space inside", "\u{5BB6} \u{5EAD}"],
  ["a single emoji", "\u{1F3E0}"],
  ["punctuation only", "?!"],
  ["exactly 50 characters", "a".repeat(50)],
  ["50 emoji (counted as characters, not bytes)", "\u{1F3E0}".repeat(50)],
];

const refused: readonly (readonly [string, string])[] = [
  ["a zero-width space inside", "Thu\u{200B}is"],
  ["only a zero-width space", "\u{200B}"],
  ["a word joiner", "Thuis\u{2060}"],
  ["a soft hyphen", "Thu\u{AD}is"],
  ["a right-to-left override", "Thuis\u{202E}"],
  ["direction isolates", "\u{2067}Thuis\u{2069}"],
  ["a left-to-right mark", "Thuis\u{200E}"],
  ["an Arabic letter mark", "Thuis\u{61C}"],
  ["only a Hangul filler", "\u{3164}"],
  ["a halfwidth Hangul filler", "A\u{FFA0}B"],
  ["only a Braille blank", "\u{2800}"],
  ["a line separator", "A\u{2028}B"],
  ["a control character", "A\u{7}B"],
  ["a combining grapheme joiner", "A\u{34F}B"],
  ["a Mongolian vowel separator", "A\u{180E}B"],
  ["only a combining mark", "\u{301}"],
  ["a leading zero-width joiner", "\u{200D}Thuis"],
  ["a trailing zero-width joiner", "Thuis\u{200D}"],
  ["a joiner after a space", "A \u{200D}B"],
  ["a joiner before a space", "A\u{200D} B"],
  ["two joiners in a row", "A\u{200D}\u{200D}B"],
  ["a joiner before a variation selector", "A\u{200D}\u{FE0F}"],
  ["a leading variation selector", "\u{FE0F}Thuis"],
  ["a variation selector after a space", "A \u{FE0F}"],
  ["two variation selectors in a row", "A\u{FE0F}\u{FE0F}"],
  ["a stray tag character", "Thuis\u{E0041}"],
  ["a language tag", "\u{E0001}Thuis"],
  ["an unfinished tag flag", "\u{1F3F4}\u{E0067}\u{E0062}"],
];

describe("normalizeName", () => {
  it("normalizes to NFC and trims every kind of whitespace", () => {
    expect(normalizeName("  Cafe\u{301} ")).toBe("Caf\u{E9}");
    expect(normalizeName("\u{3000}Thuis\u{A0}\u{2003}")).toBe("Thuis");
    expect(normalizeName("\u{FEFF}Thuis")).toBe("Thuis");
  });
});

describe("nameProblem", () => {
  it.each(accepted)("accepts %s", (_label, name) => {
    expect(nameProblem(normalizeName(name), 50)).toBeNull();
  });

  it.each(refused)("refuses %s", (_label, name) => {
    expect(nameProblem(normalizeName(name), 50)).toBe("invalid");
  });

  it("counts characters, not UTF-16 units, against the limit", () => {
    expect(nameProblem("a".repeat(51), 50)).toBe("tooLong");
    expect(nameProblem("\u{1F3E0}".repeat(51), 50)).toBe("tooLong");
  });
});
