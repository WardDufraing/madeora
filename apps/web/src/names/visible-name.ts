/**
 * The name policy for names other people see (S09; the stricter rule S07's review deferred until
 * names became visible to others). Home names use it from S09; display names and nicknames switch
 * to it in S11, when the member directory shows them to other members.
 *
 * A name may look like another name: the spec allows duplicate and visually similar names. What it
 * may not do is hide: no invisible-only names, no zero-width or direction characters that change
 * how the text around it reads, no stray characters that make two names differ invisibly.
 *
 * The database checks the same rules on its own (supabase/migrations/20261016090000_homes.sql,
 * `homes_name_check`); keep both in step. The database can only list code points, so for lone
 * combining marks of rarer scripts it is a little more lenient than this file.
 *
 * Client-safe: forms and API routes share it.
 */

/** Joiners: allowed only between two visible characters (emoji sequences, Persian, Indic text). */
const joiners = new Set([0x200c, 0x200d]);

function isVariationSelector(codePoint: number): boolean {
  return (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isTag(codePoint: number): boolean {
  return codePoint >= 0xe0020 && codePoint <= 0xe007f;
}

// A complete emoji tag flag (for example England): the black flag, tag letters, a cancel tag.
const tagFlag = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu;

// Characters that are invisible or change the text around them: controls, format characters
// (zero-width space, direction marks, overrides and isolates, word joiner, BOM, soft hyphen),
// line and paragraph separators, surrogates, every default-ignorable code point (Hangul fillers,
// Mongolian selectors, the combining grapheme joiner, ...) and the Braille blank. Joiners,
// variation selectors and tags are handled separately above.
const hidden = /^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]$/u;

const whitespace = /^\s$/u;

// At least one character must actually show: a letter, digit, symbol (emoji included) or
// punctuation mark.
const visible = /[\p{L}\p{N}\p{S}\p{P}]/u;

export type NameProblem = "tooLong" | "invalid";

/** NFC-normalized and trimmed of all Unicode whitespace, as names are stored. */
export function normalizeName(value: string): string {
  return value.normalize("NFC").trim();
}

/**
 * What is wrong with an already normalized, non-empty name, or `null` when it is acceptable.
 * Length counts characters (code points), as the database does.
 */
export function nameProblem(name: string, maxLength: number): NameProblem | null {
  const codePoints = Array.from(name, (character) => character.codePointAt(0) ?? 0);
  if (codePoints.length > maxLength) return "tooLong";
  if (!visible.test(name)) return "invalid";

  const outsideFlags = Array.from(name.replace(tagFlag, ""), (c) => c.codePointAt(0) ?? 0);
  if (outsideFlags.some(isTag)) return "invalid";

  for (const [index, codePoint] of codePoints.entries()) {
    const previous = codePoints[index - 1];
    const next = codePoints[index + 1];
    const attachable = (neighbour: number | undefined) =>
      neighbour !== undefined &&
      !joiners.has(neighbour) &&
      !whitespace.test(String.fromCodePoint(neighbour));

    if (joiners.has(codePoint)) {
      if (!attachable(previous) || !attachable(next) || isVariationSelector(next ?? 0)) {
        return "invalid";
      }
      continue;
    }
    if (isVariationSelector(codePoint)) {
      if (!attachable(previous) || isVariationSelector(previous ?? 0)) return "invalid";
      continue;
    }
    if (isTag(codePoint)) continue;
    if (hidden.test(String.fromCodePoint(codePoint))) return "invalid";
  }
  return null;
}
