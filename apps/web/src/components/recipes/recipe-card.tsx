import { useTranslations } from "next-intl";
import Link from "next/link";

import type { RecipeSummary } from "@/recipes/api";
import { recipePath } from "@/recipes/format";

import { RecipeCover } from "./recipe-cover";
import { RatingSummary, RecipeTimes } from "./recipe-meta";

export interface RecipeCardProps {
  readonly recipe: RecipeSummary;
  readonly homeId: string | null;
}

/**
 * One recipe in the library (S24): cover, name (the link), times, servings, the context's rating,
 * whether it is one of the viewer's favorites, and the ingredient a search matched through.
 */
export function RecipeCard({ recipe, homeId }: RecipeCardProps) {
  const t = useTranslations("Recipes");
  return (
    <article
      className="relative flex h-full flex-col gap-3 rounded-card border border-line bg-surface p-3"
      data-testid="recipe-card"
    >
      <RecipeCover fileId={recipe.coverFileId} size="card" />
      <div className="flex flex-col gap-1">
        <h2 className="text-body font-semibold text-fg">
          {/* The whole card is clickable through the link's stretched hit area. */}
          <Link
            href={recipePath(homeId, recipe.id)}
            className="after:absolute after:inset-0 after:rounded-card focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-focus"
          >
            <bdi>{recipe.name}</bdi>
          </Link>
        </h2>
        {recipe.matchedIngredient ? (
          <p className="text-helper text-fg-muted">
            {t("matchedIngredient", { ingredient: recipe.matchedIngredient })}
          </p>
        ) : null}
        <RecipeTimes prepMinutes={recipe.prepMinutes} cookMinutes={recipe.cookMinutes} />
        <p className="flex flex-wrap gap-x-3 gap-y-1">
          <RatingSummary average={recipe.ratingAverage} count={recipe.ratingCount} />
          {recipe.favorite ? (
            <span className="text-helper font-medium text-accent-fg">{t("favoriteBadge")}</span>
          ) : null}
        </p>
        {recipe.tags.length > 0 ? (
          <ul aria-label={t("tagsLabel")} className="flex flex-wrap gap-1">
            {recipe.tags.map((tag) => (
              <li
                key={tag}
                className="rounded-full bg-surface-sunken px-2 py-0.5 text-helper text-fg-muted"
              >
                <bdi>{tag}</bdi>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}
