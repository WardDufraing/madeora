import { contrastRatio, mix, normalizeHex, towardsContrast, type Hex } from "./color.ts";
import { neutral, type NeutralTokens, type Theme } from "./neutral.ts";

/** Every colour the interface draws from the accent. Nothing else may use the accent. */
export interface AccentTokens {
  /** Solid fill for primary actions and selected controls. */
  readonly accent: Hex;
  readonly accentHover: Hex;
  readonly accentPressed: Hex;
  /** Text and icons drawn on `accent`, `accentHover` and `accentPressed`. */
  readonly onAccent: Hex;
  /** Quiet solid tint for selected or highlighted areas (never a gradient). */
  readonly accentSubtle: Hex;
  /** Accent-coloured text and icons on the page, surfaces and `accentSubtle`. */
  readonly accentFg: Hex;
  /** Keyboard focus outline. */
  readonly focusRing: Hex;
  /**
   * Edge of accent-filled controls such as a checked checkbox: the accent itself when it stands
   * out from every surface (3:1), otherwise moved towards the text colour until it does, so the
   * control's outline never disappears with a very light or very dark accent.
   */
  readonly accentEdge: Hex;
}

const WHITE: Hex = "#ffffff";
const BLACK: Hex = "#000000";
// Dark text on light accents uses the dark theme's page colour rather than pure black.
const INK: Hex = "#10141d";

/** WCAG 2.2 AA minimums used by the derivation. */
export const CONTRAST = { text: 4.5, ui: 3 } as const;

function pickOnColour(background: Hex): Hex {
  return contrastRatio(WHITE, background) >= contrastRatio(INK, background) ? WHITE : INK;
}

/**
 * Derives the full set of accent tokens for one theme from a single solid colour.
 *
 * Guarantees (spec: "validate contrast and derive accessible hover/pressed states"): text on the
 * accent meets 4.5:1, hover and pressed only ever increase that contrast, accent text meets 4.5:1
 * and the focus ring and `accentEdge` 3:1 on every page surface. The fill itself is not held to
 * 3:1 against surfaces (a white accent on a white card is allowed), so controls that rely on the
 * fill to show their shape draw `accentEdge` around it. When the
 * chosen colour cannot carry readable text, the fill is nudged just far enough, so the caller
 * should show the returned `accent`, not the input, in previews.
 */
export function deriveAccent(input: string, theme: Theme): AccentTokens {
  const base = normalizeHex(input);
  const n: NeutralTokens = neutral[theme];

  let onAccent = pickOnColour(base);
  let away = onAccent === WHITE ? BLACK : WHITE;
  let accent = base;
  if (contrastRatio(onAccent, accent) < CONTRAST.text) {
    accent = towardsContrast(base, away, [onAccent], CONTRAST.text);
    onAccent = pickOnColour(accent);
    away = onAccent === WHITE ? BLACK : WHITE;
  }

  const accentSubtle = mix(n.surface, accent, theme === "light" ? 0.12 : 0.2);
  const surfaces = [n.page, n.sidebar, n.surface, n.surfaceElevated];

  return {
    accent,
    accentHover: mix(accent, away, 0.12),
    accentPressed: mix(accent, away, 0.24),
    onAccent,
    accentSubtle,
    accentFg: towardsContrast(base, n.fg, [...surfaces, accentSubtle], CONTRAST.text),
    focusRing: towardsContrast(base, n.fg, surfaces, CONTRAST.ui),
    accentEdge: towardsContrast(accent, n.fg, surfaces, CONTRAST.ui),
  };
}

/**
 * Default accent: the purple from the specification's colour table. It is only the default
 * value of the accent tokens (docs/design/design-decisions.md), never used directly.
 */
export const defaultAccent: Readonly<Record<Theme, Hex>> = {
  light: "#8057f5",
  dark: "#936bff",
};
