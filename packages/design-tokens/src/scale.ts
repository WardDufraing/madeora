import type { Hex } from "./color.ts";
import type { Theme } from "./neutral.ts";

/**
 * Typography. The spec leaves the production font open ("choose and license a production font
 * separately"), so the system sans-serif stack is used until one is chosen.
 * Sizes follow the spec's suggested scale: page title 28–32px, section title 18–20px,
 * body 14–16px, helper text 12–14px.
 */
export const fontFamily = {
  sans: '"Plus Jakarta Sans Variable", "Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
} as const;

export const fontSize = {
  "page-title": { size: "2rem", lineHeight: "2.5rem" },
  "section-title": { size: "1.1875rem", lineHeight: "1.75rem" },
  body: { size: "0.9375rem", lineHeight: "1.5rem" },
  helper: { size: "0.8125rem", lineHeight: "1.25rem" },
} as const;

/** 4px grid (spec). Values in px for platform-neutral use; the web app uses Tailwind's 4px spacing. */
export const spacingUnitPx = 4;

/**
 * Moderately rounded geometry (redesign decision 16): about 12-16px for cards and 6-10px for
 * controls. Overlay panels (dialogs, sheets, side panels) get a slightly larger radius.
 */
export const radius = {
  control: "0.75rem",
  card: "1.5rem",
  overlay: "1.75rem",
  /** Buttons, chips and search fields (UI makeover): fully rounded ends. */
  pill: "9999px",
  /** The 20px checkbox box: a control radius would make it look round. */
  checkbox: "0.375rem",
} as const;

export type ElevationRole = "raised" | "overlay" | "inset" | "selected";

/**
 * Pronounced tactile depth (redesign decisions 14, 15, 22), as one role per surface purpose:
 * `raised` for widget cards, `overlay` for dialogs, menus and sheets, `inset` for pressed and
 * recessed controls, `selected` for the chosen item (add a border or ring in the accent edge colour: depth is not a state signal). Each pairs a soft highlight with a layered
 * shadow, tuned separately per theme. Only two shadow layers and no blur filters, to keep scrolling
 * cheap. Depth never carries state alone: components keep borders, labels and focus rings.
 */
export const elevation: Readonly<Record<Theme, Readonly<Record<ElevationRole, string>>>> = {
  light: {
    raised:
      "inset 0 1px 0 rgb(255 255 255 / 1), 0 1px 2px rgb(21 26 41 / 0.04), 0 12px 32px rgb(21 26 41 / 0.07)",
    overlay:
      "inset 0 1px 0 rgb(255 255 255 / 1), 0 8px 20px rgb(21 26 41 / 0.1), 0 32px 64px rgb(21 26 41 / 0.16)",
    inset: "inset 0 2px 4px rgb(21 26 41 / 0.1), inset 0 -1px 0 rgb(255 255 255 / 0.8)",
    selected: "inset 0 1px 0 rgb(255 255 255 / 0.9), 0 1px 3px rgb(21 26 41 / 0.1)",
  },
  dark: {
    raised:
      "inset 0 1px 0 rgb(255 255 255 / 0.06), 0 1px 2px rgb(0 0 0 / 0.3), 0 16px 40px rgb(0 0 0 / 0.35)",
    overlay:
      "inset 0 1px 0 rgb(255 255 255 / 0.09), 0 6px 16px rgb(0 0 0 / 0.5), 0 24px 56px rgb(0 0 0 / 0.55)",
    inset: "inset 0 2px 5px rgb(0 0 0 / 0.45), inset 0 -1px 0 rgb(255 255 255 / 0.05)",
    selected: "inset 0 1px 0 rgb(255 255 255 / 0.07), 0 1px 3px rgb(0 0 0 / 0.4)",
  },
};

/**
 * Balanced spacing (redesign decision 17): semantic gaps and paddings for the dashboard grid,
 * widget shells, panels and controls. `tokens.css` lowers the roomy ones on narrow viewports;
 * touch targets are never reduced.
 */
export const space = {
  "grid-gap": "1.5rem",
  "widget-padding": "1.5rem",
  "widget-header-gap": "1rem",
  "panel-padding": "2rem",
  "control-gap": "0.5rem",
  /** Page gutter of the main content canvas. */
  "canvas-gutter": "2rem",
} as const;

/** Narrow viewports (below 40rem): the roomy spacing tokens shrink a step. */
export const spaceCompact: Readonly<Partial<Record<keyof typeof space, string>>> = {
  "grid-gap": "1rem",
  "widget-padding": "1.25rem",
  "panel-padding": "1.5rem",
  "canvas-gutter": "1rem",
};

/** Readable width of the main content canvas on ultrawide screens (redesign decision 42). */
export const canvasMaxWidth = "96rem";

/**
 * App shell (spec: persistent desktop sidebar, expanded approximately 240px, collapsed
 * approximately 72px).
 */
export const shell = {
  "sidebar-expanded": "15rem",
  "sidebar-collapsed": "4.5rem",
} as const;

/** Icon sizes in px. Icons are drawn on a 24px grid with a 2px stroke. */
export const iconSize = { sm: 16, md: 20, lg: 24 } as const;
export type IconSize = keyof typeof iconSize;

/**
 * Motion (redesign decision 23: subtle, purposeful; sidebar ~200-250ms). Durations and
 * displacements become 0 when the user prefers reduced motion, so every transition built on them
 * stops moving while state changes stay visible.
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

/** Distances an element travels while entering, and the press feedback scale. */
export const motion = {
  "shift-sm": "0.25rem",
  "shift-md": "0.75rem",
  "press-scale": "0.98",
} as const;

/** What `motion` becomes under reduced motion: no travel, no scale. */
export const motionReduced: Readonly<Record<keyof typeof motion, string>> = {
  "shift-sm": "0rem",
  "shift-md": "0rem",
  "press-scale": "1",
};

/**
 * The dashboard canvas (redesign decision 21): a restrained, neutral tonal gradient behind the
 * raised surfaces, on the page background only. It is deliberately not built from the accent, so
 * the single user accent never becomes a second palette. Primary and muted text meet 4.5:1 on
 * both stops (tested). Solid `page` colour is the fallback for forced colours and reduced
 * transparency.
 */
export const canvas: Readonly<Record<Theme, { readonly from: Hex; readonly to: Hex }>> = {
  light: { from: "#f3f4fa", to: "#e7eaf3" },
  dark: { from: "#141926", to: "#0a0d14" },
};

/**
 * Task priority hues (redesign decision 52): a narrow semantic exception to the single accent.
 * They reuse the status tones, so contrast is already validated; the UI always pairs them with a
 * name or icon.
 */
export type Priority = "high" | "medium" | "low";
export const priorities: readonly Priority[] = ["high", "medium", "low"];
