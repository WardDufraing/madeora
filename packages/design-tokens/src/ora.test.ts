import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { contrastRatio } from "./color.ts";
import {
  defaultOraPalette,
  isOraPaletteKey,
  oraPaletteKeys,
  oraPaletteVariables,
  oraPalettes,
} from "./ora.ts";

describe("Ora palettes", () => {
  it("has nine stable keys and Heather as the default", () => {
    expect(oraPaletteKeys).toHaveLength(9);
    expect(new Set(oraPaletteKeys).size).toBe(9);
    expect(defaultOraPalette).toBe("heather");
  });

  it("defines every palette with five body stops from light to shade", () => {
    for (const key of oraPaletteKeys) {
      const palette = oraPalettes[key];
      expect(palette.body).toHaveLength(5);
      // Lighter at the top-left stop than at the shaded edge.
      expect(contrastRatio(palette.body[0], palette.body[3])).toBeGreaterThan(1.5);
      for (const colour of [...palette.body, palette.ink, palette.brow, palette.blush]) {
        expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("keeps the smile and closed eyes readable on the lightest body colour", () => {
    for (const key of oraPaletteKeys) {
      const palette = oraPalettes[key];
      expect(contrastRatio(palette.ink, palette.body[0])).toBeGreaterThanOrEqual(7);
    }
  });

  it("matches the keys the database accepts", () => {
    const sql = readFileSync(
      new URL("../../../supabase/migrations/20261206090000_ora_settings.sql", import.meta.url),
      "utf8",
    );
    const listed = [...sql.matchAll(/in \(\s*((?:'[a-z-]+',?\s*)+)\)/g)].filter((match) =>
      (match[1] ?? "").includes("heather"),
    );
    expect(listed.length).toBeGreaterThanOrEqual(2);
    for (const match of listed) {
      const keys = [...(match[1] ?? "").matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
      expect(keys).toEqual([...oraPaletteKeys]);
    }
  });

  it("recognises keys", () => {
    expect(isOraPaletteKey("denim")).toBe(true);
    expect(isOraPaletteKey("Denim")).toBe(false);
    expect(isOraPaletteKey(5)).toBe(false);
  });

  it("exposes one palette as CSS variables", () => {
    const variables = oraPaletteVariables("heather");
    expect(variables["--ora-body-0"]).toBe("#e9e0ee");
    expect(variables["--ora-ink"]).toBe("#382d40");
    expect(variables["--ora-eye-1"]).toBe("#30271e");
  });
});
