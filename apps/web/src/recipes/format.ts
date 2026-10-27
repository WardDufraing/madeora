import { isValidServings, quantityInput } from "@madeora/domain/recipes";

import type { RecipeDetail } from "./api";
import { emptyIngredient, type RecipeFormValues } from "./schema";

/** Client-safe helpers of the recipe pages (S24). */

/** The library of a context: the Personal space (`null`) or a Home. */
export function recipesPath(homeId: string | null): string {
  return homeId ? `/homes/${homeId}/recipes` : "/recipes";
}

/** A published recipe's page, or its editor or cooking mode. */
export function recipePath(
  homeId: string | null,
  recipeId: string,
  part?: "edit" | "cook",
): string {
  const base = `${recipesPath(homeId)}/${recipeId}`;
  return part ? `${base}/${part}` : base;
}

export const DRAFTS_PATH = "/recipes/drafts";

export function draftPath(draftId: string): string {
  return `${DRAFTS_PATH}/${draftId}`;
}

/** Where to open a new recipe; `homeId` is where it is meant to go. */
export function newRecipePath(homeId: string | null): string {
  return `${recipesPath(homeId)}/new`;
}

/**
 * Typed TanStack Query keys, always scoped by account and context (architecture.md §9); everything
 * under `all` is dropped after a change.
 */
export const recipeKeys = {
  all: ["recipes"] as const,
  page: (userId: string, homeId: string | null, query: string, loadedAt: string) =>
    ["recipes", userId, homeId ?? "personal", "page", query, loadedAt] as const,
  detail: (userId: string, recipeId: string) => ["recipes", userId, "detail", recipeId] as const,
};

/** A recipe's content as the editor's values, every field as text a person can type back in. */
export function toRecipeForm(recipe: RecipeDetail): RecipeFormValues {
  const text = (value: number | null) => (value === null ? "" : String(value));
  return {
    name: recipe.name ?? "",
    servings: text(recipe.servings),
    servingsLabel: recipe.servingsLabel ?? "",
    prepMinutes: text(recipe.prepMinutes),
    cookMinutes: text(recipe.cookMinutes),
    notes: recipe.notes ?? "",
    tags: [...recipe.tags],
    ingredients:
      recipe.ingredients.length > 0
        ? recipe.ingredients.map((ingredient) => ({
            name: ingredient.name,
            quantity: ingredient.quantity ? quantityInput(ingredient.quantity) : "",
            unit: ingredient.unit ?? "",
            note: ingredient.note ?? "",
          }))
        : [emptyIngredient()],
    steps: recipe.steps.length > 0 ? recipe.steps.map((step) => ({ text: step })) : [{ text: "" }],
    coverFileId: recipe.coverFileId,
  };
}

/** Whole minutes as hours and minutes for display (`{ hours: 1, minutes: 30 }`). */
export function splitMinutes(total: number): { readonly hours: number; readonly minutes: number } {
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** The selected serving count from the address, when it is a valid one (1–999). */
export function servingsFromParam(value: string | string[] | undefined): number | null {
  const text = Array.isArray(value) ? value[0] : value;
  if (!text || !/^\d{1,3}$/.test(text)) return null;
  const number = Number(text);
  return isValidServings(number) ? number : null;
}
