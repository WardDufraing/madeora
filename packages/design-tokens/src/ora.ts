/**
 * Ora's colours (Ora design handoff, 17 October 2026). The nine palettes are the user's choice per
 * Home and in Personal space, independent of the accent colour; the stable keys are what the
 * database stores (never the display names, which are translated and may change). Eyes,
 * highlights and glints do not follow the palette. Values are copied from the handoff and must not
 * be re-tuned here without the owner's approval.
 */

import type { Hex } from "./color.ts";

export const oraPaletteKeys = [
  "muted-teal",
  "denim",
  "terracotta",
  "olive",
  "ochre",
  "heather",
  "brick",
  "petrol",
  "cocoa",
] as const;

export type OraPaletteKey = (typeof oraPaletteKeys)[number];

/** Heather (smoky purple) until a person chooses: Personal space and every Home. */
export const defaultOraPalette: OraPaletteKey = "heather";

export function isOraPaletteKey(value: unknown): value is OraPaletteKey {
  return typeof value === "string" && (oraPaletteKeys as readonly string[]).includes(value);
}

export interface OraPalette {
  /** Body stops at 0 %, 32 %, 64 %, 85 % and 100 %; the hands reuse indices 0, 1, 3 and 4. */
  readonly body: readonly [Hex, Hex, Hex, Hex, Hex];
  /** The smile and the closed eyes. */
  readonly ink: Hex;
  readonly brow: Hex;
  /** The cheeks (drawn at opacity 0.23). */
  readonly blush: Hex;
}

export const oraPalettes: { readonly [K in OraPaletteKey]: OraPalette } = {
  "muted-teal": {
    body: ["#daede4", "#a3c7bc", "#76a69c", "#4b7870", "#87afa3"],
    ink: "#293c36",
    brow: "#577f73",
    blush: "#d4a28d",
  },
  denim: {
    body: ["#e0eaf3", "#b0c6dc", "#819fbe", "#526e8e", "#8ea8c2"],
    ink: "#2b3543",
    brow: "#627e99",
    blush: "#d0a4a5",
  },
  terracotta: {
    body: ["#f6dfcf", "#ddb49a", "#c18c72", "#925d48", "#c79a80"],
    ink: "#473129",
    brow: "#976d58",
    blush: "#cf8b7c",
  },
  olive: {
    body: ["#e7e9cf", "#c2c69c", "#9ca477", "#737b50", "#a9ae84"],
    ink: "#343a26",
    brow: "#727d51",
    blush: "#cb9b80",
  },
  ochre: {
    body: ["#f5e7c6", "#dec491", "#c3a263", "#92763f", "#cbae79"],
    ink: "#483921",
    brow: "#957b4b",
    blush: "#c78e70",
  },
  heather: {
    body: ["#e9e0ee", "#c7b4d0", "#a28bab", "#776283", "#b29cbb"],
    ink: "#382d40",
    brow: "#7e688a",
    blush: "#c99ba6",
  },
  brick: {
    body: ["#efd8d1", "#d1a399", "#b77d73", "#8a574f", "#c08d81"],
    ink: "#442b28",
    brow: "#95675b",
    blush: "#d49a88",
  },
  petrol: {
    body: ["#d4e4e4", "#9cbabf", "#6d969e", "#496c77", "#83a6ae"],
    ink: "#233940",
    brow: "#567b84",
    blush: "#cca092",
  },
  cocoa: {
    body: ["#ecdfd1", "#cbb39c", "#ab8b71", "#7d624e", "#b69b83"],
    ink: "#3e2f25",
    brow: "#886f57",
    blush: "#c7907b",
  },
};

/** Parts of the character that stay the same in every palette. */
export const oraFixed = {
  /** The dark glossy eyes (and the open mouth), at 0 %, 45 % and 100 %. */
  eye: ["#655545", "#30271e", "#17130f"],
  eyeHighlight: "#fff9e9",
  eyeGlint: "#d1baa1",
  eyeShadow: "#8c7759",
  /** The soft upper-left highlight on the body. */
  light: "#fffdf5",
} as const;

/** CSS custom properties that carry one palette to the character (see OraCharacter). */
export function oraPaletteVariables(key: OraPaletteKey): Record<string, string> {
  const palette = oraPalettes[key];
  const fixed = oraFixed;
  return {
    "--ora-body-0": palette.body[0],
    "--ora-body-1": palette.body[1],
    "--ora-body-2": palette.body[2],
    "--ora-body-3": palette.body[3],
    "--ora-body-4": palette.body[4],
    "--ora-ink": palette.ink,
    "--ora-brow": palette.brow,
    "--ora-blush": palette.blush,
    "--ora-eye-0": fixed.eye[0],
    "--ora-eye-1": fixed.eye[1],
    "--ora-eye-2": fixed.eye[2],
    "--ora-eye-highlight": fixed.eyeHighlight,
    "--ora-eye-glint": fixed.eyeGlint,
    "--ora-eye-shadow": fixed.eyeShadow,
    "--ora-light": fixed.light,
  };
}
