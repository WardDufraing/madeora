import { describe, expect, it } from "vitest";

import { CONTRAST, defaultAccent, deriveAccent } from "./accent.ts";
import { contrastRatio } from "./color.ts";
import { neutral, themes } from "./neutral.ts";

// A spread of accents a person might choose, including hard cases: very light, very dark,
// mid-grey (worst case for text on a fill) and saturated yellow.
const accents = [
  "#8057f5",
  "#936bff",
  "#0e7c66",
  "#e11d48",
  "#f59e0b",
  "#ffe600",
  "#ffffff",
  "#000000",
  "#777777",
  "#757575",
  "#22d3ee",
  "#1e3a8a",
  "#a3e635",
];

describe("deriveAccent", () => {
  for (const theme of themes) {
    const n = neutral[theme];
    const surfaces = [n.page, n.sidebar, n.surface, n.surfaceElevated];

    for (const input of accents) {
      it(`keeps every accent state accessible for ${input} in ${theme}`, () => {
        const t = deriveAccent(input, theme);
        expect(contrastRatio(t.onAccent, t.accent)).toBeGreaterThanOrEqual(CONTRAST.text);
        expect(contrastRatio(t.onAccent, t.accentHover)).toBeGreaterThanOrEqual(CONTRAST.text);
        expect(contrastRatio(t.onAccent, t.accentPressed)).toBeGreaterThanOrEqual(CONTRAST.text);
        // Hover and pressed never reduce contrast with the text on them.
        expect(contrastRatio(t.onAccent, t.accentHover)).toBeGreaterThanOrEqual(
          contrastRatio(t.onAccent, t.accent),
        );
        expect(contrastRatio(t.onAccent, t.accentPressed)).toBeGreaterThanOrEqual(
          contrastRatio(t.onAccent, t.accentHover),
        );
        for (const surface of [...surfaces, t.accentSubtle]) {
          expect(contrastRatio(t.accentFg, surface)).toBeGreaterThanOrEqual(CONTRAST.text);
          expect(contrastRatio(n.fg, surface)).toBeGreaterThanOrEqual(CONTRAST.text);
        }
        for (const surface of surfaces) {
          expect(contrastRatio(t.focusRing, surface)).toBeGreaterThanOrEqual(CONTRAST.ui);
        }
      });
    }
  }

  it("keeps the default purple unchanged as the fill in both themes", () => {
    expect(deriveAccent(defaultAccent.light, "light").accent).toBe("#8057f5");
    expect(deriveAccent(defaultAccent.dark, "dark").accent).toBe("#936bff");
  });

  it("produces different tokens for a different accent", () => {
    const purple = deriveAccent("#8057f5", "light");
    const green = deriveAccent("#0e7c66", "light");
    for (const key of Object.keys(purple) as (keyof typeof purple)[]) {
      if (key === "onAccent") continue;
      expect(green[key]).not.toBe(purple[key]);
    }
  });

  it("rejects colours that are not solid hex values", () => {
    expect(() => deriveAccent("linear-gradient(red, blue)", "light")).toThrow();
    expect(() => deriveAccent("rgb(0 0 0 / 0.5)", "dark")).toThrow();
  });
});
