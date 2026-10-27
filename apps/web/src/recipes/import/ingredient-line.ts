import { parseQuantity, type RecipeUnit } from "@madeora/domain/recipes";

/**
 * Reads one ingredient line of an imported recipe ("2 1/2 cups flour", "200 g bloem") into a
 * quantity, a supported unit and the rest of the line as the name (S25). Only what is clearly
 * there: a line it cannot read with confidence (a range such as "2-3 eggs", a number it cannot
 * parse) is kept exactly as written, without a quantity, and flagged for review. Units are never
 * converted; a unit word Madeora does not support stays part of the name.
 */

export interface ImportedIngredient {
  readonly name: string;
  /** The quantity as text the editor reads back (`1 1/2`, `0.5`), or "" for none. */
  readonly quantity: string;
  readonly unit: RecipeUnit | null;
  /** True when the line was kept as written because part of it could not be read with confidence. */
  readonly asWritten: boolean;
}

const unitWords: { readonly [unit in RecipeUnit]: readonly string[] } = {
  g: ["g", "gr", "gram", "grams", "gramme", "grammes"],
  kg: ["kg", "kilo", "kilos", "kilogram", "kilograms", "kilogramme", "kilogrammes"],
  mg: ["mg", "milligram", "milligrams"],
  ml: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"],
  cl: ["cl", "centiliter", "centiliters", "centilitre", "centilitres"],
  dl: ["dl", "deciliter", "deciliters", "decilitre", "decilitres"],
  l: ["l", "liter", "liters", "litre", "litres"],
  tsp: ["tsp", "tsps", "teaspoon", "teaspoons", "tl", "theelepel", "theelepels"],
  tbsp: ["tbsp", "tbsps", "tbs", "tablespoon", "tablespoons", "el", "eetlepel", "eetlepels"],
  cup: ["cup", "cups", "kop", "kopje", "kopjes"],
  fl_oz: ["fl oz", "fl. oz", "fluid ounce", "fluid ounces"],
  oz: ["oz", "ounce", "ounces"],
  lb: ["lb", "lbs", "pound", "pounds"],
  piece: ["piece", "pieces", "pc", "pcs", "stuk", "stuks"],
  pinch: ["pinch", "pinches", "snufje", "snufjes"],
  clove: ["clove", "cloves", "teen", "teentje", "teentjes", "tenen"],
  slice: ["slice", "slices", "plak", "plakken", "plakje", "plakjes"],
  can: ["can", "cans", "tin", "tins", "blik", "blikken", "blikje", "blikjes"],
  jar: ["jar", "jars", "pot", "potten", "potje", "potjes"],
  pack: [
    "pack",
    "packs",
    "package",
    "packages",
    "packet",
    "packets",
    "pak",
    "pakken",
    "pakje",
    "pakjes",
  ],
  bunch: ["bunch", "bunches", "bos", "bossen", "bosje", "bosjes"],
  sprig: ["sprig", "sprigs", "takje", "takjes"],
  handful: ["handful", "handfuls", "handvol", "handje", "handjes"],
};

// Longest first, so "fl oz" wins over "oz" and "kilo" over "kg"-like prefixes.
const units: readonly (readonly [string, RecipeUnit])[] = Object.entries(unitWords)
  .flatMap(([unit, words]) => words.map((word) => [word, unit as RecipeUnit] as const))
  .sort((a, b) => b[0].length - a[0].length);

const fractionChars = "½⅓⅔¼¾⅕⅛⅜⅝⅞";
const quantityPattern = new RegExp(
  `^(\\d{1,6} \\d{1,4}/\\d{1,4}|\\d{1,4}/\\d{1,4}|\\d{1,6}[.,]\\d{1,3}|\\d{1,6} ?[${fractionChars}]|[${fractionChars}]|\\d{1,6})(?![\\d.,/])`,
  "u",
);
// A second number right after the first ("2-3", "2 to 3", "1 of 2"): a range, never guessed.
const rangePattern = /^\s*(?:-|–|—|to|tot|or|of)\s*\d/iu;

function plain(name: string): ImportedIngredient {
  return { name, quantity: "", unit: null, asWritten: false };
}

function asWritten(name: string): ImportedIngredient {
  return { name, quantity: "", unit: null, asWritten: true };
}

export function parseIngredientLine(line: string): ImportedIngredient {
  const text = line.replace(/^[\s\-•*·▪◦]+/u, "").trim();
  const match = quantityPattern.exec(text);
  if (!match?.[1]) {
    // Starts with a digit it cannot read ("2x", "1.000.000"): keep it as written, flagged.
    return /^\d/u.test(text) ? asWritten(text) : plain(text);
  }
  const typed = match[1];
  let rest = text.slice(typed.length);
  if (rangePattern.test(rest)) return asWritten(text);
  // "1.000 g" or "1,500 ml" may be a thousands separator or three decimals: never guessed.
  if (/^\d{1,3}[.,]\d{3}$/u.test(typed)) return asWritten(text);
  const quantity = parseQuantity(typed.replace(/ ?([½⅓⅔¼¾⅕⅛⅜⅝⅞])$/u, " $1").trim());
  if (!quantity) return asWritten(text);
  // Glued to the number, only a unit is read ("200g flour"); anything else ("2x flour") is not guessed.
  const glued = rest !== "" && !/^\s/u.test(rest);
  rest = rest.trim();
  let unit: RecipeUnit | null = null;
  const lower = rest.toLowerCase();
  for (const [word, candidate] of units) {
    if (lower.startsWith(word)) {
      const after = rest.slice(word.length);
      // A whole word (optionally with a period): "g flour", "tbsp. sugar", never "garlic".
      const ending = /^\.?(?=\s|$)/u.exec(after);
      if (ending) {
        unit = candidate;
        rest = after.slice(ending[0].length).trim();
        break;
      }
    }
  }
  if (glued && !unit) return asWritten(text);
  // "1 cup of flour", "1 blik van 400 g": the joining word is not part of the name.
  if (unit) rest = rest.replace(/^(?:of|van)\s+/iu, "");
  if (rest === "") return asWritten(text);
  return {
    name: rest,
    // The editor reads what a person would type; a unicode fraction stays as typed (`1 ½`).
    quantity: typed.replace(/ ?([½⅓⅔¼¾⅕⅛⅜⅝⅞])$/u, " $1").trim(),
    unit,
    asWritten: false,
  };
}
