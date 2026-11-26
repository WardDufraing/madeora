import type { Hex } from "./color.ts";

export type Theme = "light" | "dark";
export const themes: readonly Theme[] = ["light", "dark"];

/** Non-accent interface colours. Values from the specification's colour table unless noted. */
export interface NeutralTokens {
  readonly page: Hex;
  readonly sidebar: Hex;
  readonly surface: Hex;
  readonly surfaceElevated: Hex;
  /** Spec "Primary text". */
  readonly fg: Hex;
  /** Spec "Secondary text". */
  readonly fgMuted: Hex;
  /** Spec "Border": card and divider edges. Decorative, so not held to 3:1. */
  readonly line: Hex;
  /**
   * Outlines of inputs and checkboxes. Not in the spec's table: its border colour is too faint
   * to identify a control (WCAG 1.4.11 needs 3:1), so controls get their own token.
   */
  readonly lineControl: Hex;
}

export const neutral: Readonly<Record<Theme, NeutralTokens>> = {
  light: {
    page: "#f0f2f4",
    sidebar: "#ffffff",
    surface: "#ffffff",
    surfaceElevated: "#ffffff",
    fg: "#10181c",
    fgMuted: "#586368",
    line: "#e4e8ea",
    lineControl: "#6b777d",
  },
  dark: {
    page: "#0b1013",
    sidebar: "#060a0c",
    surface: "#141b1f",
    surfaceElevated: "#1b2429",
    fg: "#f1f5f6",
    fgMuted: "#9aa7ad",
    line: "#222c32",
    lineControl: "#76848b",
  },
};

/** Backdrop behind modal dialogs. Translucent, so it is not a solid hex value. */
export const overlay: Readonly<Record<Theme, string>> = {
  light: "rgb(21 26 41 / 0.45)",
  dark: "rgb(0 0 0 / 0.6)",
};
