import {
  accentPalette,
  defaultAccent,
  deriveAccent,
  type Hex,
  type PaletteId,
} from "@madeora/design-tokens";
import { z } from "zod";

/**
 * Personal accent colours (S11; spec "Confirmed personal accent color with per-Home overrides",
 * "Confirmed shared Home theme and member-identifying accent colors"). A person picks one solid
 * colour; every shade the interface draws is derived from it with `deriveAccent`, which keeps text
 * and focus contrast whatever is chosen. Stored as lower-case `#rrggbb`, which the database checks
 * too (supabase/migrations/20261018090000_member_profiles.sql). Client-safe.
 */

export type AccentColor = Hex;

const hexPattern = /^#[0-9a-f]{6}$/;

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === "string" && hexPattern.test(value);
}

/** Error message key, translated in the `Accent` namespace. */
export type AccentError = "accentInvalid";

/** A solid colour as `#rrggbb` in any case, stored in lower case. */
export const accentColorSchema = z
  .string({ error: "accentInvalid" satisfies AccentError })
  .max(32, { error: "accentInvalid" satisfies AccentError })
  .transform((value, context): AccentColor => {
    const lower = value.trim().toLowerCase();
    if (!isAccentColor(lower)) {
      context.addIssue({ code: "custom", message: "accentInvalid" satisfies AccentError });
      return z.NEVER;
    }
    return lower;
  });

/** A stored value read defensively: anything unexpected counts as "not chosen". */
export function parseAccentColor(value: unknown): AccentColor | null {
  return isAccentColor(value) ? value : null;
}

/** The curated palette (from the design tokens), re-exported for the app. */
export { accentPalette, type PaletteId };

/** The accent everyone has until they choose one: the specification's purple. */
export const DEFAULT_ACCENT: AccentColor = defaultAccent.light;

/** The palette entry for a colour, if it is one. */
export function paletteEntry(color: AccentColor): (typeof accentPalette)[number] | undefined {
  return accentPalette.find((entry) => entry.color === color);
}

/** The colour in effect: the Home override, else the global accent, else the default. */
export function effectiveAccent(
  override: AccentColor | null,
  global: AccentColor | null,
): AccentColor {
  return override ?? global ?? DEFAULT_ACCENT;
}

/**
 * The solid fill and the text colour on it for a member's avatar or swatch. Both are the same in
 * light and dark themes (`deriveAccent` only moves the fill when text on it would be unreadable).
 */
export function accentFill(color: AccentColor): {
  readonly fill: string;
  readonly onFill: string;
  /** Whether the fill had to be adjusted from the chosen colour for readable text. */
  readonly adjusted: boolean;
} {
  const tokens = deriveAccent(color, "light");
  return { fill: tokens.accent, onFill: tokens.onAccent, adjusted: tokens.accent !== color };
}
