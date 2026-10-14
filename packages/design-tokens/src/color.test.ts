import { describe, expect, it } from "vitest";

import { contrastRatio, mix, normalizeHex, relativeLuminance, towardsContrast } from "./color.ts";

describe("colour helpers", () => {
  it("normalizes short and upper-case hex and rejects anything else", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex(" #8057F5 ")).toBe("#8057f5");
    for (const bad of ["8057f5", "#12345", "#gggggg", "red", "rgb(0 0 0)", "#8057f5aa", ""]) {
      expect(() => normalizeHex(bad)).toThrow("#rgb or #rrggbb");
    }
  });

  it("computes WCAG luminance and contrast", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBe(1);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    // Known reference value: #767676 on white is the classic 4.54:1.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#8057f5", "#ffffff")).toBe(contrastRatio("#ffffff", "#8057f5"));
  });

  it("mixes in sRGB like CSS color-mix", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#123456", "#ffffff", 0)).toBe("#123456");
    expect(mix("#123456", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#123456", "#ffffff", 7)).toBe("#ffffff");
  });

  it("moves a colour only as far as needed to reach a contrast target", () => {
    const result = towardsContrast("#bbbbbb", "#000000", ["#ffffff"], 4.5);
    expect(contrastRatio(result, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(result, "#ffffff")).toBeLessThan(5.5);
    expect(towardsContrast("#000000", "#ffffff", ["#ffffff"], 4.5)).toBe("#000000");
  });
});
