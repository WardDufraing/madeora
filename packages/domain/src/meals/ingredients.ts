/**
 * Building the editable rows of a date-range ingredient transfer (S27; spec "Confirmed meal-plan
 * date-range shopping transfer"). Pure and framework-free.
 *
 * One row per ingredient of each included meal, never merged. Quantities are scaled by the meal's
 * chosen servings over the recipe's yield only when both exist (otherwise left as written and the
 * meal says "not scaled"), then written as a shopping quantity: at most three decimals, marked
 * approximate when that rounds. Recipe units that shopping supports stay units; any other unit
 * becomes the item's packaging text. Nothing is converted, estimated or summed.
 */
import { isValidServings, makeQuantity, type Quantity, type RecipeUnit } from "../recipes/quantity";
import { isShoppingUnit, SHOPPING_LIMITS, type ShoppingUnit } from "../shopping/quantity";

/** One ingredient as the transfer preview answers it. */
export interface TransferIngredient {
  readonly position: number;
  readonly name: string;
  readonly quantityNum: number | null;
  readonly quantityDen: number | null;
  readonly unit: RecipeUnit | null;
  readonly note: string | null;
}

/** One meal of the range as the transfer preview answers it. */
export interface TransferMeal {
  readonly key: string;
  readonly date: string;
  readonly slotId: string;
  readonly status: "included" | "custom" | "unavailable";
  readonly title: string | null;
  readonly servings: number | null;
  readonly recipe: {
    readonly id: string;
    readonly name: string;
    readonly servings: number | null;
    readonly ingredients: readonly TransferIngredient[];
  } | null;
}

export interface TransferRow {
  /** Stable within one preview: the meal key and the ingredient position. */
  readonly key: string;
  readonly mealKey: string;
  readonly name: string;
  /** A canonical shopping quantity ("0.75"), or null when there is none or it cannot be one. */
  readonly quantity: string | null;
  readonly unit: ShoppingUnit | null;
  /** A recipe unit shopping does not support, to be written as the item's packaging text. */
  readonly packagingUnit: RecipeUnit | null;
  readonly notes: string | null;
  /** Written with at most three decimals, which rounded the exact amount. */
  readonly approximate: boolean;
  /** The amount was outside what a shopping item can hold (kept out of `quantity`). */
  readonly quantityDropped: boolean;
}

export interface TransferMealRows {
  readonly meal: TransferMeal;
  /** True when servings and yield were both known and the amounts were scaled. */
  readonly scaled: boolean;
  readonly rows: readonly TransferRow[];
}

/** The factor of a meal: its chosen servings over the recipe's yield, when both are valid. */
function scaling(meal: TransferMeal): { readonly num: number; readonly den: number } | null {
  const original = meal.recipe?.servings ?? null;
  if (original === null || meal.servings === null) return null;
  if (!isValidServings(original) || !isValidServings(meal.servings)) return null;
  return { num: meal.servings, den: original };
}

/**
 * An exact quantity as a shopping quantity: thousandths, rounded half up. `approximate` when that
 * changed the value; null when it rounds to nothing or exceeds the shopping limit.
 */
export function toShoppingQuantity(quantity: Quantity): {
  readonly value: string | null;
  readonly approximate: boolean;
} {
  const thousandths = Math.round((quantity.num * 1000) / quantity.den);
  const approximate = (quantity.num * 1000) % quantity.den !== 0;
  if (thousandths <= 0 || thousandths > SHOPPING_LIMITS.maxQuantity * 1000) {
    return { value: null, approximate };
  }
  const whole = Math.floor(thousandths / 1000);
  const rest = thousandths % 1000;
  const value =
    rest === 0
      ? String(whole)
      : `${String(whole)}.${String(rest).padStart(3, "0").replace(/0+$/, "")}`;
  return { value, approximate };
}

/** The rows of every included meal, in the order the preview answered the meals. */
export function buildTransferRows(meals: readonly TransferMeal[]): readonly TransferMealRows[] {
  return meals
    .filter((meal) => meal.status === "included" && meal.recipe !== null)
    .map((meal) => {
      const factor = scaling(meal);
      const rows = (meal.recipe?.ingredients ?? []).map((ingredient): TransferRow => {
        let quantity: string | null = null;
        let approximate = false;
        let quantityDropped = false;
        if (ingredient.quantityNum !== null && ingredient.quantityDen !== null) {
          const exact = makeQuantity(
            ingredient.quantityNum * (factor?.num ?? 1),
            ingredient.quantityDen * (factor?.den ?? 1),
            "decimal",
          );
          if (exact !== null) {
            const shopping = toShoppingQuantity(exact);
            quantity = shopping.value;
            approximate = shopping.approximate && shopping.value !== null;
            quantityDropped = shopping.value === null;
          }
        }
        const supported = quantity !== null && isShoppingUnit(ingredient.unit);
        return {
          key: `${meal.key}#${String(ingredient.position)}`,
          mealKey: meal.key,
          name: ingredient.name,
          quantity,
          unit: supported ? ingredient.unit : null,
          packagingUnit: !supported && ingredient.unit !== null ? ingredient.unit : null,
          notes: ingredient.note,
          approximate,
          quantityDropped,
        };
      });
      return { meal, scaled: factor !== null, rows };
    });
}
