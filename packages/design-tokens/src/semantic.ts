import { contrastRatio, mix, type Hex } from "./color.ts";
import { neutral, type Theme } from "./neutral.ts";

/**
 * Status colours. The spec names success, warning, danger and information without values;
 * these are chosen for contrast in both themes. They are always paired with an icon or text,
 * never used as the only signal (spec: "distinguishable without color alone").
 */
export type Tone = "success" | "warning" | "danger" | "info";
export const tones: readonly Tone[] = ["success", "warning", "danger", "info"];

export interface ToneTokens {
  /** Text and icons in this tone on the page and surfaces. */
  readonly fg: Hex;
  /** Quiet solid background for messages in this tone. */
  readonly subtle: Hex;
  /** Solid fill, for example a destructive button. */
  readonly solid: Hex;
  /** Text and icons on `solid`. */
  readonly onSolid: Hex;
}

const base: Readonly<Record<Theme, Record<Tone, Hex>>> = {
  light: {
    success: "#067647",
    warning: "#b54708",
    danger: "#b42318",
    info: "#175cd3",
  },
  dark: {
    success: "#47cd89",
    warning: "#fdb022",
    danger: "#f97066",
    info: "#53b1fd",
  },
};

function onSolid(solid: Hex): Hex {
  const white: Hex = "#ffffff";
  const ink: Hex = "#10141d";
  return contrastRatio(white, solid) >= contrastRatio(ink, solid) ? white : ink;
}

function toneTokens(theme: Theme, tone: Tone): ToneTokens {
  const colour = base[theme][tone];
  return {
    fg: colour,
    subtle: mix(neutral[theme].surface, colour, theme === "light" ? 0.06 : 0.14),
    solid: colour,
    onSolid: onSolid(colour),
  };
}

export const semantic: Readonly<Record<Theme, Readonly<Record<Tone, ToneTokens>>>> = {
  light: {
    success: toneTokens("light", "success"),
    warning: toneTokens("light", "warning"),
    danger: toneTokens("light", "danger"),
    info: toneTokens("light", "info"),
  },
  dark: {
    success: toneTokens("dark", "success"),
    warning: toneTokens("dark", "warning"),
    danger: toneTokens("dark", "danger"),
    info: toneTokens("dark", "info"),
  },
};
