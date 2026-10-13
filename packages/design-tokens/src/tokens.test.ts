import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CONTRAST } from "./accent.ts";
import { contrastRatio, isHex, type Hex } from "./color.ts";
import { colourNames, renderTailwindCss, renderTokensCss, themeVariables } from "./css.ts";
import { neutral, themes } from "./neutral.ts";
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

  it("removes Tailwind's default colour palette", () => {
    expect(renderTailwindCss()).toContain("--color-*: initial;");
  });

  it("builds the atmospheric background from tokens only, never a hard-coded colour", () => {
    const line = renderTokensCss()
      .split("\n")
      .find((l) => l.includes("--md-atmosphere:"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    expect(line).toContain("var(--md-color-accent)");
  });
});
