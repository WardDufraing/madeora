import type { Hex } from "./color.ts";
import type { Theme } from "./neutral.ts";

/**
 * Typography. The spec leaves the production font open ("choose and license a production font
 * separately"), so the system sans-serif stack is used until one is chosen.
 * Sizes follow the spec's suggested scale: page title 28–32px, section title 18–20px,
 * body 14–16px, helper text 12–14px.
 */
export const fontFamily = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
} as const;

export const fontSize = {
  "page-title": { size: "1.875rem", lineHeight: "2.375rem" },
  "section-title": { size: "1.125rem", lineHeight: "1.625rem" },
  body: { size: "0.9375rem", lineHeight: "1.5rem" },
  helper: { size: "0.8125rem", lineHeight: "1.25rem" },
} as const;

/** 4px grid (spec). Values in px for platform-neutral use; the web app uses Tailwind's 4px spacing. */
export const spacingUnitPx = 4;

/** Spec: card radius 14–18px, control radius 9–12px; avoid pill-shaped controls everywhere. */
export const radius = {
  control: "0.625rem",
  card: "1rem",
} as const;

/** Restrained depth (spec: flat or very subtle elevation, no heavy glassmorphism). */
export const elevation: Readonly<
  Record<Theme, { readonly card: string; readonly overlay: string }>
> = {
  light: {
    card: "0 1px 2px rgb(21 26 41 / 0.04), 0 4px 16px rgb(21 26 41 / 0.04)",
    overlay: "0 4px 12px rgb(21 26 41 / 0.08), 0 16px 40px rgb(21 26 41 / 0.12)",
  },
  dark: {
    card: "0 1px 2px rgb(0 0 0 / 0.3), 0 4px 16px rgb(0 0 0 / 0.2)",
    overlay: "0 4px 12px rgb(0 0 0 / 0.4), 0 16px 40px rgb(0 0 0 / 0.45)",
  },
};

/** Icon sizes in px. Icons are drawn on a 24px grid with a 2px stroke. */
export const iconSize = { sm: 16, md: 20, lg: 24 } as const;
export type IconSize = keyof typeof iconSize;

/**
 * Motion (spec: purposeful and subtle; sidebar ~200–250ms). Durations become 0ms when the user
 * prefers reduced motion, so every transition built on them stops moving.
 */
export const duration = {
  fast: "120ms",
  base: "200ms",
  slow: "240ms",
} as const;

export const easing = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  enter: "cubic-bezier(0, 0, 0, 1)",
  exit: "cubic-bezier(0.3, 0, 1, 1)",
} as const;

/**
 * The page-only atmospheric background (spec): a very low-opacity radial wash that fades into the
 * page colour. It is built from the accent and a cool blue, so it follows the accent instead of
 * hard-coding purple. It is switched off for reduced transparency and forced colours.
 */
export const atmosphere: Readonly<
  Record<
    Theme,
    { readonly cool: Hex; readonly accentStrength: string; readonly coolStrength: string }
  >
> = {
  light: { cool: "#5b8def", accentStrength: "10%", coolStrength: "8%" },
  dark: { cool: "#3d6fe0", accentStrength: "18%", coolStrength: "12%" },
};
