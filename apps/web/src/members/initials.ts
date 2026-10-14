/**
 * Up to two initials for an avatar (S11: image avatars come with file storage, S15): the first
 * character of the first and last word, as whole graphemes so accents, emoji and other scripts
 * stay intact. `null` when there is no name. Client-safe.
 */
export function initials(name: string | null, locale: string): string | null {
  if (name === null) return null;
  const words = name.split(/\s+/u).filter((word) => word !== "");
  const segmenter = new Intl.Segmenter(locale, { granularity: "grapheme" });
  const first = (word: string | undefined): string => {
    if (word === undefined) return "";
    const graphemes = Array.from(segmenter.segment(word), (part) => part.segment);
    // Skip leading punctuation such as "(" or quotes when a letter, number or emoji follows.
    return (
      graphemes.find((g) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(g)) ?? graphemes[0] ?? ""
    );
  };
  const letters = words.length > 1 ? first(words[0]) + first(words.at(-1)) : first(words[0]);
  return letters === "" ? null : letters.toLocaleUpperCase(locale);
}
