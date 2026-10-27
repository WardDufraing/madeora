/**
 * Recipe permissions (S24). Pure and framework-free, like ./home.ts. The database makes the same
 * decisions on every call (`private.can_manage_recipes`, `private.can_edit_recipe`,
 * `private.can_see_recipe` in supabase/migrations/*_recipes.sql); the server and the interface use
 * this module to decide what to offer, never instead of those checks.
 *
 * Default picked in the S24 brief (the per-module permission matrix is open in the spec; the owner
 * may override):
 * - A draft belongs to its creator alone, whatever Home it is meant for: nobody else sees, rates,
 *   favorites or edits it, Home managers and the Owner included (spec "Confirmed private recipe
 *   drafts"). Its creator edits, publishes and discards it.
 * - Personal space: its owner does everything with its published recipes.
 * - Home: every current member views, rates, favorites and publishes recipes into the Home; the
 *   recipe's creator, while still a member, and recipe managers (the Owner, Administrators granted
 *   `manageHomeRecipes`) edit it under the exclusive lock and delete it to the trash. Being the
 *   creator alone never grants anything (spec "Confirmed context-owned canonical recipes").
 */
import { decideHomeAction, type HomeDecision, type HomeMembershipFacts } from "./home";

export const recipeActions = [
  "recipe.view",
  "recipe.edit",
  "recipe.delete",
  "recipe.rate",
  "recipe.favorite",
  "recipe.publish",
] as const;
export type RecipeAction = (typeof recipeActions)[number];

/** A recipe and the acting person's relation to it, as the database reports them now. */
export type RecipeFacts =
  | { readonly status: "draft"; readonly createdByMe: boolean }
  | { readonly status: "published"; readonly context: "personal"; readonly ownedByMe: boolean }
  | {
      readonly status: "published";
      readonly context: "home";
      readonly homeId: string;
      readonly createdByMe: boolean;
    };

const allowed: HomeDecision = { allowed: true };
const refused: HomeDecision = { allowed: false, reason: "not-permitted" };
const hidden: HomeDecision = { allowed: false, reason: "not-member" };

/**
 * Whether the person may perform `action` on the recipe. For a Home recipe, `membership` is their
 * current membership of that Home (null: none); a membership of another Home never counts.
 */
export function decideRecipeAction(
  recipe: RecipeFacts,
  membership: HomeMembershipFacts | null,
  action: RecipeAction,
): HomeDecision {
  if (recipe.status === "draft") {
    if (!recipe.createdByMe) return hidden;
    // A draft is unpublished: it cannot be rated or favorited (spec: drafts are not listed in
    // favorites, and cannot be rated).
    return action === "recipe.rate" || action === "recipe.favorite" ? refused : allowed;
  }
  if (recipe.context === "personal") {
    if (!recipe.ownedByMe) return hidden;
    return action === "recipe.publish" ? refused : allowed;
  }
  const view = decideHomeAction(recipe.homeId, membership, "home.recipes.view");
  if (!view.allowed) return view;
  switch (action) {
    case "recipe.publish":
      // Already published.
      return refused;
    case "recipe.view":
    case "recipe.rate":
    case "recipe.favorite":
      return allowed;
    case "recipe.edit":
    case "recipe.delete":
      return recipe.createdByMe ||
        decideHomeAction(recipe.homeId, membership, "home.recipes.manage").allowed
        ? allowed
        : refused;
  }
}

export type RecipePermissionProjection = { readonly [A in RecipeAction]: boolean };

/** Every recipe action's answer for one person and recipe, for the interface. Never authoritative. */
export function recipePermissions(
  recipe: RecipeFacts,
  membership: HomeMembershipFacts | null,
): RecipePermissionProjection {
  const can = (action: RecipeAction) => decideRecipeAction(recipe, membership, action).allowed;
  return {
    "recipe.view": can("recipe.view"),
    "recipe.edit": can("recipe.edit"),
    "recipe.delete": can("recipe.delete"),
    "recipe.rate": can("recipe.rate"),
    "recipe.favorite": can("recipe.favorite"),
    "recipe.publish": can("recipe.publish"),
  };
}
