/**
 * Recipe ingredient quantities and serving scaling (S24; spec "Confirmed structured everyday recipe
 * fields", "Confirmed recipe serving-size scaling"). Pure and framework-free.
 *
 * A quantity is an exact positive fraction plus the way its author typed it, so "1/3" stays a third
 * (never 0.333…) and "0.25" stays 0.25. Scaling multiplies by `selected / original` exactly; only
 * the display may round, and then it says so and keeps the exact value available. There are no unit
 * conversions, no "smart" rounding and no default yield. The database stores the same three parts
 * (`quantity_num`, `quantity_den`, `quantity_style`) and checks the same limits.
 */

export const quantityStyles = ["decimal", "fraction"] as const;
export type QuantityStyle = (typeof quantityStyles)[number];

export interface Quantity {
  /** Numerator, a positive whole number. */
  readonly num: number;
  /** Denominator, a positive whole number; always reduced together with `num`. */
  readonly den: number;
  readonly style: QuantityStyle;
}

export const RECIPE_LIMITS = {
  /** The largest quantity (100 000 of a unit). */
  maxQuantity: 100_000,
  /** The largest denominator a typed value may have (three decimals or x/1000). */
  maxDenominator: 1000,
  /** A whole serving yield and a selected serving count. */
  minServings: 1,
  maxServings: 999,
} as const;

/** The units a recipe may name (brief S24); anything else belongs in the ingredient's note. */
export const recipeUnits = [
  "g",
  "kg",
  "mg",
  "ml",
  "cl",
  "dl",
  "l",
  "tsp",
  "tbsp",
  "cup",
  "fl_oz",
  "oz",
  "lb",
  "piece",
  "pinch",
  "clove",
  "slice",
  "can",
  "jar",
  "pack",
  "bunch",
  "sprig",
  "handful",
] as const;
export type RecipeUnit = (typeof recipeUnits)[number];

export function isRecipeUnit(value: unknown): value is RecipeUnit {
  return typeof value === "string" && (recipeUnits as readonly string[]).includes(value);
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** `num/den` reduced, or null when it is not a positive fraction of safe whole numbers. */
export function makeQuantity(num: number, den: number, style: QuantityStyle): Quantity | null {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) return null;
  const divisor = gcd(num, den);
  return { num: num / divisor, den: den / divisor, style };
}

/** Whether a stored quantity is within the limits the database checks. */
export function isValidQuantity(quantity: Quantity): boolean {
  return (
    Number.isSafeInteger(quantity.num) &&
    Number.isSafeInteger(quantity.den) &&
    quantity.num > 0 &&
    quantity.den > 0 &&
    quantity.den <= RECIPE_LIMITS.maxDenominator &&
    quantity.num <= RECIPE_LIMITS.maxQuantity * quantity.den &&
    gcd(quantity.num, quantity.den) === 1 &&
    (quantityStyles as readonly string[]).includes(quantity.style)
  );
}

const unicodeFractions: { readonly [c: string]: readonly [number, number] } = {
  "½": [1, 2],
  "⅓": [1, 3],
  "⅔": [2, 3],
  "¼": [1, 4],
  "¾": [3, 4],
  "⅕": [1, 5],
  "⅛": [1, 8],
  "⅜": [3, 8],
  "⅝": [5, 8],
  "⅞": [7, 8],
};

function within(quantity: Quantity | null): Quantity | null {
  return quantity !== null && isValidQuantity(quantity) ? quantity : null;
}

/**
 * Reads what a person typed: `2`, `1.5` or `1,5` (up to three decimals, no thousands separators),
 * `1/2`, `1 1/2`, `½` or `1½`. Answers null for anything else, zero, negative or too large values.
 */
export function parseQuantity(input: string): Quantity | null {
  const text = input.trim().replace(/\s+/g, " ");
  if (text === "") return null;
  let match = /^(\d{1,6})(?:[.,](\d{1,3}))?$/.exec(text);
  if (match) {
    const whole = Number(match[1]);
    const decimals = match[2] ?? "";
    const den = 10 ** decimals.length;
    return within(makeQuantity(whole * den + Number(decimals || "0"), den, "decimal"));
  }
  match = /^(?:(\d{1,6}) )?(\d{1,4})\/(\d{1,4})$/.exec(text);
  if (match) {
    const whole = Number(match[1] ?? "0");
    const num = Number(match[2]);
    const den = Number(match[3]);
    if (den === 0 || (match[1] !== undefined && num >= den)) return null;
    return within(makeQuantity(whole * den + num, den, "fraction"));
  }
  match = /^(\d{1,6})? ?([½⅓⅔¼¾⅕⅛⅜⅝⅞])$/u.exec(text);
  if (match) {
    const [num, den] = unicodeFractions[match[2] as string] as readonly [number, number];
    const whole = Number(match[1] ?? "0");
    return within(makeQuantity(whole * den + num, den, "fraction"));
  }
  return null;
}

/** A quantity as text a person can type back in (`1.5`, `1 1/2`): the editor's starting value. */
export function quantityInput(quantity: Quantity): string {
  if (quantity.den === 1) return String(quantity.num);
  if (quantity.style === "fraction") {
    const whole = Math.floor(quantity.num / quantity.den);
    const rest = quantity.num % quantity.den;
    return whole > 0
      ? `${String(whole)} ${String(rest)}/${String(quantity.den)}`
      : `${String(rest)}/${String(quantity.den)}`;
  }
  // Decimal style only ever stores denominators that divide 1000.
  return decimalText(quantity.num, quantity.den, 3);
}

function decimalText(num: number, den: number, digits: number): string {
  const scale = 10 ** digits;
  const scaled = Math.round((num * scale) / den);
  const whole = Math.floor(scaled / scale);
  const rest = scaled % scale;
  if (rest === 0) return String(whole);
  return `${String(whole)}.${String(rest).padStart(digits, "0").replace(/0+$/, "")}`;
}

/** Whether a serving count is valid: a whole number 1–999. */
export function isValidServings(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RECIPE_LIMITS.minServings &&
    value <= RECIPE_LIMITS.maxServings
  );
}

/**
 * The quantity for `selected` servings of a recipe that yields `original`. Exact; keeps the style.
 * Null when either count is invalid (no yield means no scaling, never an assumed one).
 */
export function scaleQuantity(
  quantity: Quantity,
  original: number | null,
  selected: number,
): Quantity | null {
  if (original === null || !isValidServings(original) || !isValidServings(selected)) return null;
  return makeQuantity(quantity.num * selected, quantity.den * original, quantity.style);
}

export interface QuantityDisplay {
  /** What to show, in the locale's number format (`1 ½` is shown as `1 1/2`). */
  readonly text: string;
  /** True when `text` is rounded; then `exact` says the precise value. */
  readonly approximate: boolean;
  /** The precise value as a fraction (`7/3`) or exact decimal, for "show the exact amount". */
  readonly exact: string;
}

/** The largest denominator shown as a fraction; beyond it a fraction is unreadable. */
const READABLE_DENOMINATOR = 16;

/**
 * How to show a quantity. Whole numbers as they are; fraction-typed values as a mixed fraction
 * while the denominator stays readable; decimal-typed values exactly when they fit three decimals.
 * Otherwise two decimals, marked approximate, with the exact fraction alongside.
 */
export function formatQuantity(quantity: Quantity, locale: string): QuantityDisplay {
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits, useGrouping: false }).format(
      value,
    );
  const exactFraction = `${String(quantity.num)}/${String(quantity.den)}`;
  if (quantity.den === 1) {
    const text = number(quantity.num, 0);
    return { text, approximate: false, exact: text };
  }
  if (quantity.style === "fraction" && quantity.den <= READABLE_DENOMINATOR) {
    const whole = Math.floor(quantity.num / quantity.den);
    const rest = quantity.num % quantity.den;
    const part = `${String(rest)}/${String(quantity.den)}`;
    const text = whole > 0 ? `${number(whole, 0)} ${part}` : part;
    return { text, approximate: false, exact: text };
  }
  if (1000 % quantity.den === 0) {
    const text = number(quantity.num / quantity.den, 3);
    return { text, approximate: false, exact: text };
  }
  const text = number(Math.round((quantity.num / quantity.den) * 100) / 100, 2);
  return { text, approximate: true, exact: exactFraction };
}

/**
 * Total time in minutes only when both parts are known (spec: "Show a combined total only when the
 * available values support an unambiguous total"); otherwise null and each part is shown alone.
 */
export function totalMinutes(prep: number | null, cook: number | null): number | null {
  return prep !== null && cook !== null ? prep + cook : null;
}
