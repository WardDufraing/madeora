/**
 * Small colour helpers for solid sRGB colours written as `#rrggbb`.
 * Contrast follows WCAG 2.2 (relative luminance and contrast ratio).
 */

export type Hex = `#${string}`;

const HEX_PATTERN = /^#[0-9a-f]{6}$/;

export function isHex(value: string): value is Hex {
  return HEX_PATTERN.test(value);
}

/** Accepts `#rgb` or `#rrggbb` in any case and returns lower-case `#rrggbb`. */
export function normalizeHex(value: string): Hex {
  const lower = value.trim().toLowerCase();
  const expanded = /^#[0-9a-f]{3}$/.test(lower)
    ? lower.replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3")
    : lower;
  if (!isHex(expanded)) {
    throw new Error("Expected a solid colour written as #rgb or #rrggbb.");
  }
  return expanded;
}

type Rgb = readonly [number, number, number];

function toRgb(hex: Hex): Rgb {
  const value = Number.parseInt(normalizeHex(hex).slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function toHex([r, g, b]: Rgb): Hex {
  const part = (channel: number) =>
    Math.round(Math.min(255, Math.max(0, channel)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

function linearChannel(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: Hex): number {
  const [r, g, b] = toRgb(hex);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: Hex, b: Hex): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** Mixes `amount` (0 to 1) of `other` into `base`, in sRGB like CSS `color-mix(in srgb, …)`. */
export function mix(base: Hex, other: Hex, amount: number): Hex {
  const t = Math.min(1, Math.max(0, amount));
  const from = toRgb(base);
  const to = toRgb(other);
  return toHex([
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ]);
}

/**
 * Moves `colour` towards `target` in small steps until it reaches `minimum` contrast against
 * every colour in `against`. Returns the first colour that does, or `target` itself.
 */
export function towardsContrast(
  colour: Hex,
  target: Hex,
  against: readonly Hex[],
  minimum: number,
): Hex {
  for (let step = 0; step <= 50; step += 1) {
    const candidate = mix(colour, target, step / 50);
    if (against.every((background) => contrastRatio(candidate, background) >= minimum)) {
      return candidate;
    }
  }
  return target;
}

/** The colour in OKLab (L 0 to 1), a space where distances follow how different colours look. */
export function toOklab(hex: Hex): readonly [number, number, number] {
  const [r, g, b] = toRgb(hex).map(linearChannel) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * How different two colours look: the Euclidean distance in OKLab. 0 is identical; about 0.02 is
 * the smallest difference people notice side by side, and small swatches need several times that.
 */
export function oklabDistance(a: Hex, b: Hex): number {
  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
