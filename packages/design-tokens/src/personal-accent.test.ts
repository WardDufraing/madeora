import { describe, expect, it } from "vitest";

import { deriveAccent } from "./accent.ts";
import { oklabDistance, toOklab } from "./color.ts";
import { renderAccentCss } from "./css.ts";

describe("renderAccentCss", () => {
  it("overrides every accent token in light, dark and follow-the-system themes", () => {
    const css = renderAccentCss("#2563EB");
    const light = deriveAccent("#2563eb", "light");
    const dark = deriveAccent("#2563eb", "dark");
    expect(css).toContain(':root,\n[data-theme="light"] {');
    expect(css).toContain("@media (prefers-color-scheme: dark) {");
    expect(css).toContain(':root:not([data-theme="light"]) {');
    expect(css).toContain('[data-theme="dark"] {');
    expect(css).toContain(`--md-color-accent: ${light.accent};`);
    expect(css).toContain(`--md-color-accent-fg: ${dark.accentFg};`);
    expect(css).toContain(`--md-color-focus: ${light.focusRing};`);
    expect(css).toContain(`--md-color-accent-edge: ${dark.accentEdge};`);
    // Only accent tokens: the neutral palette and the atmosphere stay as they are.
    expect(css).not.toContain("--md-color-page");
    expect(css).not.toContain("--md-atmosphere");
  });

  it("can recolour one element only, for a preview", () => {
    const css = renderAccentCss("#2563eb", '[data-accent-preview="p1"]');
    expect(css).toContain('[data-accent-preview="p1"] {');
    expect(css).toContain(':root:not([data-theme="light"]) [data-accent-preview="p1"] {');
    expect(css).toContain('[data-theme="dark"] [data-accent-preview="p1"] {');
    expect(css).not.toContain(":root,");
  });

  it("uses each theme's own default accent for null", () => {
    const css = renderAccentCss(null, '[data-accent-preview="p1"]');
    expect(css).toContain(`--md-color-accent: ${deriveAccent("#8057f5", "light").accent};`);
    expect(css).toContain(`--md-color-on-accent: ${deriveAccent("#936bff", "dark").onAccent};`);
  });

  it.each(["red", "#12345", "#1234567", "#12345g", "#123456; } body { display: none", ""])(
    "refuses %j, so only a validated colour reaches a style sheet",
    (value) => {
      expect(() => renderAccentCss(value)).toThrow();
    },
  );
});

describe("oklabDistance", () => {
  it("is zero for the same colour and symmetric", () => {
    expect(oklabDistance("#2563eb", "#2563eb")).toBe(0);
    expect(oklabDistance("#2563eb", "#dc2626")).toBeCloseTo(oklabDistance("#dc2626", "#2563eb"));
  });

  it("puts white at L 1 and black at L 0", () => {
    expect(toOklab("#ffffff")[0]).toBeCloseTo(1, 3);
    expect(toOklab("#000000")[0]).toBeCloseTo(0, 3);
  });

  it("finds near-identical colours close and different hues far apart", () => {
    expect(oklabDistance("#2563eb", "#2664ea")).toBeLessThan(0.01);
    expect(oklabDistance("#2563eb", "#16a34a")).toBeGreaterThan(0.2);
  });
});
