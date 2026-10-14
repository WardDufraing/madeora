import type { Hex } from "./color.ts";

/**
 * The curated accent palette people choose from (S11; spec "Offer curated color palettes plus a
 * custom accent picker"): the specification's purple, which is the default accent, and eleven
 * other solid colours spread around the hue circle, ending with a quiet slate. Any of them, or a
 * custom colour, goes through `deriveAccent`, so contrast holds whichever is chosen. The colours
 * are far enough apart that none of them triggers the app's similar-colour warning against
 * another. Each id is also the message key of the colour's name, so no swatch is identified by
 * colour alone, and each colour is published as `--md-color-palette-<id>` for swatches.
 */
export const accentPalette = [
  { id: "purple", color: "#8057f5" },
  { id: "blue", color: "#2563eb" },
  { id: "sky", color: "#0284c7" },
  { id: "teal", color: "#0d9488" },
  { id: "green", color: "#16a34a" },
  { id: "ochre", color: "#a16207" },
  { id: "amber", color: "#d97706" },
  { id: "orange", color: "#ea580c" },
  { id: "red", color: "#dc2626" },
  { id: "pink", color: "#db2777" },
  { id: "magenta", color: "#c026d3" },
  { id: "slate", color: "#475569" },
] as const satisfies readonly { readonly id: string; readonly color: Hex }[];

export type PaletteId = (typeof accentPalette)[number]["id"];
