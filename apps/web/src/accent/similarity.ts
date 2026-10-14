import { oklabDistance } from "@madeora/design-tokens";

import { accentPalette, type AccentColor } from "./accent";

/**
 * Non-blocking advice when a member's colour would be hard to tell apart from another member's in
 * the same Home (spec "Confirmed optional duplicate member accent colors with accessibility
 * warnings"). Duplicates are allowed: this only warns and suggests, it never refuses or changes
 * anyone's colour. Compare only with members of the Home being edited, never other Homes.
 */

/** OKLab distance under which two small swatches are hard to tell apart (brief S11, decision 6). */
export const SIMILAR_DISTANCE = 0.06;

export type Similarity = "identical" | "similar" | "distinct";

export function similarity(a: AccentColor, b: AccentColor): Similarity {
  if (a === b) return "identical";
  return oklabDistance(a, b) < SIMILAR_DISTANCE ? "similar" : "distinct";
}

/** The most serious clash between `color` and the others' colours, or `distinct` for none. */
export function closestClash(color: AccentColor, others: readonly AccentColor[]): Similarity {
  let worst: Similarity = "distinct";
  for (const other of others) {
    const found = similarity(color, other);
    if (found === "identical") return found;
    if (found === "similar") worst = found;
  }
  return worst;
}

/**
 * Up to `count` palette colours that stand furthest from every colour in `others`, best first.
 * With nobody else to compare with, the palette's own order.
 */
export function suggestDistinctColors(
  others: readonly AccentColor[],
  count = 3,
): (typeof accentPalette)[number][] {
  if (others.length === 0) return accentPalette.slice(0, count);
  return accentPalette
    .map((entry, index) => ({
      entry,
      index,
      nearest: Math.min(...others.map((other) => oklabDistance(entry.color, other))),
    }))
    .filter(({ nearest }) => nearest >= SIMILAR_DISTANCE)
    .sort((a, b) => b.nearest - a.nearest || a.index - b.index)
    .slice(0, count)
    .map(({ entry }) => entry);
}
