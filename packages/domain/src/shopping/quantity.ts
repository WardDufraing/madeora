/**
 * Shopping item quantities, units and multi-line entry (S26; spec "Confirmed structured shopping
 * quantities and units", "Confirmed shopping quick-add and reviewed multi-item entry"). Pure and
 * framework-free.
 *
 * A quantity is a positive decimal with at most three decimals, kept as its canonical string
 * ("2", "0.5", "1.25") so it is never turned into a float on the way to the database, which stores
 * numeric(9, 3) and checks the same limits. Nothing is rounded, converted or aggregated, and no
 * quantity is ever assumed: a line is read as "quantity [unit] name" only when that reading is
 * unambiguous, otherwise it is kept whole and flagged for review.
 */

export const SHOPPING_LIMITS = {
  lists: 50,
  items: 500,
  categories: 30,
  recurrences: 50,
  batch: 100,
  listName: 60,
  categoryName: 40,
  itemName: 200,
  packaging: 40,
  notes: 500,
  history: 20,
  widgetLists: 5,
  widgetItems: 15,
  maxQuantity: 100_000,
} as const;

/** The units an item may name (`private.is_shopping_unit`). Packaging ("bottles") is separate. */
export const shoppingUnits = ["piece", "g", "kg", "ml", "cl", "dl", "l"] as const;
export type ShoppingUnit = (typeof shoppingUnits)[number];

export function isShoppingUnit(value: unknown): value is ShoppingUnit {
  return typeof value === "string" && (shoppingUnits as readonly string[]).includes(value);
}

const canonical = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,3})?$/;

/** Whether `value` is a canonical quantity string within the limits (what the API accepts). */
export function isShoppingQuantity(value: string): boolean {
  if (!canonical.test(value)) return false;
  const number = Number(value);
  return number > 0 && number <= SHOPPING_LIMITS.maxQuantity && !/\.[0-9]*0$/.test(value);
}

/**
 * Reads a quantity as typed in either locale: "2", "0,5", "1.25", " 12 ". Returns the canonical
 * string, or null when it is not a valid quantity (zero, negative, more than three decimals, a
 * thousands separator, anything else). Never rounds.
 *
 * "1,000" or "1.500" could be a thousands separator in one locale and three decimals in the other,
 * so a separator followed by exactly three digits after a non-zero whole part is ambiguous and
 * answers null rather than guessing ("0,125" and "1,25" are clear).
 */
export function parseShoppingQuantity(input: string): string | null {
  const trimmed = input.trim();
  if (!/^[0-9]+([.,][0-9]+)?$/.test(trimmed)) return null;
  if (/^0*[1-9][0-9]{0,2}[.,][0-9]{3}$/.test(trimmed)) return null;
  const [whole = "", fraction = ""] = trimmed.replace(",", ".").split(".");
  const integer = whole.replace(/^0+(?=[0-9])/, "");
  const decimals = fraction.replace(/0+$/, "");
  if (decimals.length > 3) return null;
  const value = decimals === "" ? integer : `${integer}.${decimals}`;
  return isShoppingQuantity(value) ? value : null;
}

/** A canonical quantity for display in `locale` ("1,25" in nl, "1.25" in en), exactly as stored. */
export function formatShoppingQuantity(value: string, locale: string): string {
  const [whole = "", fraction] = value.split(".");
  const formatter = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 });
  const integer = formatter.format(Number(whole));
  if (fraction === undefined) return integer;
  const separator =
    new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")
      ?.value ?? ".";
  return `${integer}${separator}${fraction}`;
}

/** One line of a multi-item entry, read for the editable preview. */
export interface ParsedShoppingLine {
  /** The line as typed (trimmed), always shown when `uncertain`. */
  readonly original: string;
  readonly name: string;
  readonly quantity: string | null;
  readonly unit: ShoppingUnit | null;
  /** The reading may not be what the person meant: the whole line was kept as the name. */
  readonly uncertain: boolean;
}

const unitWords: { readonly [word: string]: ShoppingUnit } = {
  g: "g",
  kg: "kg",
  ml: "ml",
  cl: "cl",
  dl: "dl",
  l: "l",
};

/**
 * Splits pasted text into one entry per non-blank line (surrounding whitespace trimmed), at most
 * `limit` lines; the rest are reported as `overflow`. Each line is read as:
 * - "500 g pasta", "500g pasta", "1,5 kg aardappelen", "2 l melk" → quantity, unit and name;
 * - "6 appels" → quantity 6, no unit;
 * - anything else ("pasta", "2-3 uien", "½ kool", "melk 2", "500 g") → the whole line as the name;
 *   when the line has digits it is flagged `uncertain` so the person checks it.
 */
export function parseShoppingLines(
  text: string,
  limit: number = SHOPPING_LIMITS.batch,
): { readonly lines: readonly ParsedShoppingLine[]; readonly overflow: number } {
  const all = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line !== "");
  return {
    lines: all.slice(0, limit).map(parseShoppingLine),
    overflow: Math.max(0, all.length - limit),
  };
}

export function parseShoppingLine(line: string): ParsedShoppingLine {
  const original = line.trim().replace(/\s+/g, " ");
  const whole: ParsedShoppingLine = {
    original,
    name: original.slice(0, SHOPPING_LIMITS.itemName),
    quantity: null,
    unit: null,
    uncertain: /[0-9½¼¾⅓⅔]/.test(original) || original.length > SHOPPING_LIMITS.itemName,
  };
  const match = /^([0-9]+(?:[.,][0-9]+)?)\s?([a-zA-Z]+)?\s(.+)$/.exec(original);
  if (!match) return whole;
  const [, amount = "", word, rest = ""] = match;
  const quantity = parseShoppingQuantity(amount);
  if (quantity === null) return whole;
  const unit = word === undefined ? undefined : unitWords[word.toLowerCase()];
  // "500g pasta" or "500 g pasta": a unit; "6 appels": the word belongs to the name.
  const name = (unit === undefined && word !== undefined ? `${word} ${rest}` : rest).trim();
  // More digits in the name ("2 x 6 eieren") make the reading doubtful: keep the line whole.
  // A unit with nothing after it ("500 g") names nothing.
  if (
    name === "" ||
    unitWords[name.toLowerCase()] !== undefined ||
    /[0-9½¼¾⅓⅔]/.test(name) ||
    name.length > SHOPPING_LIMITS.itemName
  ) {
    return whole;
  }
  return { original, name, quantity, unit: unit ?? null, uncertain: false };
}

/** The key two names compare by for duplicates: case, accents and spacing ignored. */
export function shoppingNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
