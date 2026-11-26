import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CONTRAST } from "./accent.ts";
import { contrastRatio, isHex, type Hex } from "./color.ts";
import { colourNames, renderTailwindCss, renderTokensCss, themeVariables } from "./css.ts";
import { neutral, themes } from "./neutral.ts";
import { canvas, elevation, radius, shell, space } from "./scale.ts";
import { semantic, tones } from "./semantic.ts";

describe("neutral and semantic colours", () => {
  for (const theme of themes) {
    const n = neutral[theme];
    const surfaces: Hex[] = [n.page, n.sidebar, n.surface, n.surfaceElevated];

    it(`meet WCAG AA on every surface in ${theme}`, () => {
      for (const surface of surfaces) {
        expect(contrastRatio(n.fg, surface)).toBeGreaterThanOrEqual(CONTRAST.text);
        expect(contrastRatio(n.fgMuted, surface)).toBeGreaterThanOrEqual(CONTRAST.text);
        expect(contrastRatio(n.lineControl, surface)).toBeGreaterThanOrEqual(CONTRAST.ui);
        for (const tone of tones) {
          expect(contrastRatio(semantic[theme][tone].fg, surface)).toBeGreaterThanOrEqual(
            CONTRAST.text,
          );
        }
      }
    });

    it(`keep text readable on tone backgrounds and fills in ${theme}`, () => {
      for (const tone of tones) {
        const t = semantic[theme][tone];
        expect(contrastRatio(n.fg, t.subtle)).toBeGreaterThanOrEqual(CONTRAST.text);
        expect(contrastRatio(n.fgMuted, t.subtle)).toBeGreaterThanOrEqual(CONTRAST.text);
        expect(contrastRatio(t.fg, t.subtle)).toBeGreaterThanOrEqual(CONTRAST.ui);
        expect(contrastRatio(t.onSolid, t.solid)).toBeGreaterThanOrEqual(CONTRAST.text);
      }
    });
  }

  it("uses only solid hex values for every theme colour except the translucent overlay", () => {
    for (const theme of themes) {
      for (const [name, value] of themeVariables(theme)) {
        if (!name.startsWith("--md-color-") || name === "--md-color-overlay") continue;
        expect(isHex(value), `${name} = ${value}`).toBe(true);
      }
    }
  });

  it("defines every Tailwind colour as a token in both themes", () => {
    for (const theme of themes) {
      const defined = new Set(themeVariables(theme).map(([name]) => name));
      for (const name of colourNames()) expect(defined.has(`--md-color-${name}`), name).toBe(true);
    }
  });
});

describe("generated CSS", () => {
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");

  it("is up to date (run `pnpm --filter @madeora/design-tokens generate`)", () => {
    expect(read("tokens.css")).toBe(renderTokensCss());
    expect(read("tailwind.css")).toBe(renderTailwindCss());
  });

  it("follows the system theme unless data-theme forces one", () => {
    const css = renderTokensCss();
    expect(css).toContain(
      '@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {',
    );
    expect(css).toContain('[data-theme="dark"] {');
    expect(css).toContain(':root,\n[data-theme="light"] {');
  });

  it("zeroes every motion duration for reduced motion", () => {
    const css = renderTokensCss();
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const name of ["fast", "base", "slow"])
      expect(reduced).toContain(`--md-duration-${name}: 0ms;`);
  });

  it("sizes the sidebar as the spec asks: about 240px expanded and 72px collapsed", () => {
    const px = (rem: string) => Number.parseFloat(rem) * 16;
    expect(px(shell["sidebar-expanded"])).toBe(240);
    expect(px(shell["sidebar-collapsed"])).toBe(72);
    expect(renderTokensCss()).toContain("--md-shell-sidebar-collapsed: 4.5rem;");
  });

  it("removes Tailwind's default colour palette", () => {
    expect(renderTailwindCss()).toContain("--color-*: initial;");
  });

  it("builds the canvas gradient from neutral stops only, never the accent", () => {
    const line = renderTokensCss()
      .split("\n")
      .find((l) => l.includes("--md-canvas:"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    expect(line).not.toContain("accent");
  });

  it("keeps primary and muted text readable on both canvas stops", () => {
    for (const theme of themes) {
      for (const stop of [canvas[theme].from, canvas[theme].to, canvas[theme].glow]) {
        expect(contrastRatio(neutral[theme].fg, stop)).toBeGreaterThanOrEqual(CONTRAST.text);
        expect(contrastRatio(neutral[theme].fgMuted, stop)).toBeGreaterThanOrEqual(CONTRAST.text);
      }
    }
  });

  it("uses the generous radii of the UI makeover (supersedes redesign decision 16)", () => {
    const px = (rem: string) => Number.parseFloat(rem) * 16;
    expect(px(radius.card)).toBeGreaterThanOrEqual(18);
    expect(px(radius.card)).toBeLessThanOrEqual(24);
    expect(px(radius.control)).toBeGreaterThanOrEqual(10);
    expect(px(radius.control)).toBeLessThanOrEqual(14);
    expect(px(radius.overlay)).toBeGreaterThan(px(radius.card));
  });

  it("defines every elevation role per theme, and a distinct shadow for each role", () => {
    for (const theme of themes) {
      const roles = Object.values(elevation[theme]);
      expect(new Set(roles).size).toBe(4);
      for (const role of ["raised", "overlay", "inset", "selected"] as const) {
        expect(renderTokensCss()).toContain(`--md-shadow-${role}: ${elevation[theme][role]};`);
      }
    }
  });

  it("zeroes motion travel and press scale for reduced motion", () => {
    const css = renderTokensCss();
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("--md-motion-shift-sm: 0rem;");
    expect(reduced).toContain("--md-motion-press-scale: 1;");
  });

  it("shrinks the roomy spacing tokens on narrow viewports only", () => {
    const css = renderTokensCss();
    const narrow = css.slice(css.indexOf("@media (max-width: 40rem)"));
    expect(narrow).toContain("--md-space-grid-gap: 1rem;");
    expect(css).toContain(`--md-space-grid-gap: ${space["grid-gap"]};`);
  });

  it("exposes priority colours that stay visible against surfaces in both themes", () => {
    for (const theme of themes) {
      const vars = new Map(themeVariables(theme));
      for (const priority of ["high", "medium", "low"]) {
        const colour = vars.get(`--md-color-priority-${priority}`);
        expect(colour).toBeDefined();
        expect(isHex(colour ?? "")).toBe(true);
        // A bar is a graphical object: 3:1 against the raised surface (WCAG 1.4.11).
        expect(contrastRatio(colour as Hex, neutral[theme].surface)).toBeGreaterThanOrEqual(
          CONTRAST.ui,
        );
      }
    }
    expect(colourNames()).toContain("priority-high");
  });
});
