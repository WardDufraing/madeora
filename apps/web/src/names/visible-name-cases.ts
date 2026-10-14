/**
 * The shared test list for the visible-name rule (S09, reused by S11 for display names, nicknames
 * and Home display names). The app's unit tests (visible-name.test.ts) and the database test
 * (tests/db/rls/visible-names.test.ts) both run every case, so the TypeScript rule and the SQL
 * rule `private.is_visible_name` are held to the same list. Pure data, no imports: the database
 * test imports this file directly. Each case is `[description, name as typed]`; names are
 * normalized (NFC, trimmed) before they are checked, as the app stores them.
 */

// Invisible characters are written as escapes, never literally (S07 review L1).
export const acceptedNames: readonly (readonly [string, string])[] = [
  ["a plain name", "Thuis"],
  ["a person's name", "Alex"],
  ["a name with an emoji", "Sam \u{1F31F}"],
  ["a family name with an apostrophe", "O\u{2019}Brien"],
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

export const refusedNames: readonly (readonly [string, string])[] = [
  ["a zero-width space inside", "Thu\u{200B}is"],
  ["only a zero-width space", "\u{200B}"],
  ["a word joiner", "Thuis\u{2060}"],
  ["a soft hyphen", "Thu\u{AD}is"],
  ["a text-direction override (RLO)", "Thuis\u{202E}"],
  ["direction isolates", "\u{2067}Thuis\u{2069}"],
  ["a direction mark (LRM)", "Thuis\u{200E}"],
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
