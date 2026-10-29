/**
 * Numeric habit quantities (S29; spec "Confirmed numeric habit measurement units and limited
 * conversions", "Confirmed numeric habit decimal precision and localized entry"). Pure and
 * framework-free. The database (`private.habit_unit_info`, `private.valid_habit_quantity`,
 * `private.valid_habit_tracking` in supabase/migrations/*_numeric_habits.sql) decides every case again;
 * these helpers let forms explain a refusal before sending it.
 *
 * Quantities are exact decimals with at most three decimals. In the browser they are whole numbers of
 * thousandths, so sums never meet binary floating point (0.1 + 0.2 is exactly 0.3).
 */

export const HABIT_QUANTITY = {
  /** Largest quantity or target. */
  max: 1_000_000,
  decimals: 3,
  /** Quick-add presets per tracking version. */
  quickAdds: 5,
  customUnitLength: 20,
} as const;

/** Thousandths per unit. */
const SCALE = 1000;

export const habitUnitKinds = ["preset", "custom"] as const;
export type HabitUnitKind = (typeof habitUnitKinds)[number];

export interface HabitUnitDefinition {
  readonly code: string;
  /** Units of one dimension convert into each other; other units never do. */
  readonly dimension: string;
  /** How many of the dimension's smallest unit one of this unit is. */
  readonly factor: number;
  /** Whole numbers only. */
  readonly discrete: boolean;
}

/** The unit catalogue; the order is the order a picker shows. */
export const habitUnits: readonly HabitUnitDefinition[] = [
  { code: "glasses", dimension: "glasses", factor: 1, discrete: true },
  { code: "pages", dimension: "pages", factor: 1, discrete: true },
  { code: "repetitions", dimension: "repetitions", factor: 1, discrete: true },
  { code: "ml", dimension: "volume", factor: 1, discrete: false },
  { code: "l", dimension: "volume", factor: 1000, discrete: false },
  { code: "min", dimension: "time", factor: 1, discrete: false },
  { code: "h", dimension: "time", factor: 60, discrete: false },
  { code: "m", dimension: "distance", factor: 1, discrete: false },
  { code: "km", dimension: "distance", factor: 1000, discrete: false },
];

export interface HabitUnit {
  readonly unit: string;
  readonly kind: HabitUnitKind;
}

interface UnitInfo {
  readonly dimension: string;
  readonly factor: number;
  readonly discrete: boolean;
}

/** What is known about a unit, or null for an unknown preset or an unusable custom label. */
export function habitUnitInfo({ unit, kind }: HabitUnit): UnitInfo | null {
  if (kind === "preset") {
    const found = habitUnits.find((candidate) => candidate.code === unit);
    return found
      ? { dimension: found.dimension, factor: found.factor, discrete: found.discrete }
      : null;
  }
  const label = unit.trim();
  return label === "" || Array.from(label).length > HABIT_QUANTITY.customUnitLength
    ? null
    : { dimension: `custom:${unit}`, factor: 1, discrete: false };
}

export function isDiscreteUnit(unit: HabitUnit): boolean {
  return habitUnitInfo(unit)?.discrete ?? false;
}

/** True when two units convert into each other: presets of one dimension (never custom labels). */
export function areUnitsConvertible(from: HabitUnit, to: HabitUnit): boolean {
  if (from.kind !== "preset" || to.kind !== "preset") return false;
  const a = habitUnitInfo(from);
  const b = habitUnitInfo(to);
  return a !== null && b !== null && a.dimension === b.dimension;
}

/** A quantity in thousandths: whole number, strictly positive, within the limit; whole units only whole. */
export function isValidThousandths(value: number, unit: HabitUnit): boolean {
  if (!Number.isSafeInteger(value) || value <= 0 || value > HABIT_QUANTITY.max * SCALE)
    return false;
  const info = habitUnitInfo(unit);
  return info !== null && (!info.discrete || value % SCALE === 0);
}

/** A value as the API returns it (a decimal number) in thousandths. */
export function toThousandths(value: number): number {
  return Math.round(value * SCALE);
}

/** Thousandths as the decimal string the API accepts ("1500", "1.5", "0.25"). */
export function thousandthsToDecimal(value: number): string {
  const negative = value < 0;
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute / SCALE);
  const fraction = String(absolute % SCALE)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${String(whole)}${fraction === "" ? "" : `.${fraction}`}`;
}

/** Exact sum. */
export function addThousandths(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

export type QuantityProblem =
  "empty" | "malformed" | "separator" | "precision" | "not-positive" | "range" | "whole";

export type ParsedQuantity =
  | { readonly ok: true; readonly thousandths: number }
  | { readonly ok: false; readonly problem: QuantityProblem };

/** Other bounds than a habit quantity's (goals, S30): a larger maximum, or 0 allowed. */
export interface QuantityLimits {
  /** Largest value in units (default `HABIT_QUANTITY.max`). */
  readonly max?: number;
  /** Whether 0 is a valid value (default false). */
  readonly zero?: boolean;
}

/** The decimal separator a locale writes numbers with. */
export function decimalSeparator(locale: string): string {
  const part = new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === "decimal");
  return part?.value ?? ".";
}

/**
 * Reads what a person typed in their locale: digits with at most one decimal separator of that
 * locale. The other separator, thousands separators, signs, exponents and spaces are refused with a
 * reason instead of being guessed (1.500 in Dutch is not 1500).
 */
export function parseQuantity(
  text: string,
  locale: string,
  unit?: HabitUnit,
  limits: QuantityLimits = {},
): ParsedQuantity {
  const max = limits.max ?? HABIT_QUANTITY.max;
  const raw = text.trim();
  if (raw === "") return { ok: false, problem: "empty" };
  const separator = decimalSeparator(locale);
  const other = separator === "," ? "." : ",";
  if (raw.includes(other) && !raw.includes(separator)) return { ok: false, problem: "separator" };
  if (raw.includes(other)) return { ok: false, problem: "malformed" };
  const pattern = new RegExp(`^(\\d+)(?:${separator === "." ? "\\." : separator}(\\d+))?$`);
  const match = pattern.exec(raw);
  if (!match) return { ok: false, problem: "malformed" };
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (fraction.length > HABIT_QUANTITY.decimals) return { ok: false, problem: "precision" };
  if (whole.replace(/^0+/, "").length > String(max).length) return { ok: false, problem: "range" };
  const thousandths = Number(whole) * SCALE + Number(fraction.padEnd(HABIT_QUANTITY.decimals, "0"));
  if (thousandths === 0 && limits.zero !== true) return { ok: false, problem: "not-positive" };
  if (thousandths > max * SCALE) return { ok: false, problem: "range" };
  if (unit && isDiscreteUnit(unit) && thousandths % SCALE !== 0) {
    return { ok: false, problem: "whole" };
  }
  return { ok: true, thousandths };
}

export interface Conversion {
  readonly thousandths: number;
  /** False when the exact result has more than three decimals (then `thousandths` is rounded). */
  readonly exact: boolean;
}

/** Converts between units of one dimension, exactly; null for units that never convert. */
export function convertThousandths(
  value: number,
  from: HabitUnit,
  to: HabitUnit,
): Conversion | null {
  if (from.unit === to.unit && from.kind === to.kind) return { thousandths: value, exact: true };
  if (!areUnitsConvertible(from, to)) return null;
  const a = habitUnitInfo(from);
  const b = habitUnitInfo(to);
  if (!a || !b) return null;
  const numerator = value * a.factor;
  const exact = numerator % b.factor === 0;
  return { thousandths: Math.round(numerator / b.factor), exact };
}

/** A tracking as forms send it. */
export interface NumericTrackingInput {
  readonly unit: string;
  readonly unitKind: HabitUnitKind;
  /** In thousandths. */
  readonly target: number;
  /** In thousandths. */
  readonly quickAdds: readonly number[];
}

/** The same rules as `private.valid_habit_tracking` for a numeric tracking. */
export function isValidNumericTracking(tracking: NumericTrackingInput): boolean {
  const unit = { unit: tracking.unit, kind: tracking.unitKind };
  if (habitUnitInfo(unit) === null || !isValidThousandths(tracking.target, unit)) return false;
  if (tracking.quickAdds.length > HABIT_QUANTITY.quickAdds) return false;
  if (new Set(tracking.quickAdds).size !== tracking.quickAdds.length) return false;
  return tracking.quickAdds.every((amount) => isValidThousandths(amount, unit));
}

/** Initial presets for a unit the form may offer (never converted from another unit). */
export function suggestedQuickAdds(unit: HabitUnit): readonly number[] {
  if (unit.kind === "custom") return [];
  const whole = (...amounts: number[]) => amounts.map((amount) => amount * SCALE);
  switch (unit.unit) {
    case "glasses":
      return whole(1, 2);
    case "pages":
      return whole(5, 10);
    case "repetitions":
      return whole(5, 10);
    case "ml":
      return whole(250, 500);
    case "l":
      return [250, 500];
    case "min":
      return whole(10, 30);
    case "h":
      return [500, 1000];
    case "m":
      return whole(100, 500);
    case "km":
      return [500, 1000];
    default:
      return [];
  }
}

/** Progress as a fraction of the target, capped at 1 for a bar (the text still shows the real total). */
export function progressFraction(total: number, target: number): number {
  return target <= 0 ? 0 : Math.min(1, total / target);
}
