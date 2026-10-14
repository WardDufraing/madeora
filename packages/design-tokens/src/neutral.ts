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
    page: "#f7f8fc",
    sidebar: "#ffffff",
    surface: "#ffffff",
    surfaceElevated: "#ffffff",
    fg: "#151a29",
    fgMuted: "#667085",
    line: "#e6e9f1",
    lineControl: "#868ea3",
  },
  dark: {
    page: "#10141d",
    sidebar: "#11151e",
    surface: "#1a1f2a",
    surfaceElevated: "#222836",
    fg: "#f7f8fc",
    fgMuted: "#aab3c5",
    line: "#303746",
    lineControl: "#737d92",
  },
};

/** Backdrop behind modal dialogs. Translucent, so it is not a solid hex value. */
export const overlay: Readonly<Record<Theme, string>> = {
  light: "rgb(21 26 41 / 0.45)",
  dark: "rgb(0 0 0 / 0.6)",
};
