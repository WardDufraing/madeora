"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { RECIPES_ENDPOINT, sendRecipeRequest, type RecipePage } from "@/recipes/api";
import { recipeKeys } from "@/recipes/format";

import { RecipeCard } from "./recipe-card";

export interface RecipeResultsProps {
  readonly userId: string;
  readonly homeId: string | null;
  readonly initial: RecipePage;
  /** The filters as a query string (`?q=…`), without the offset. */
  readonly query: string;
  readonly filtered: boolean;
  /** When the server read the first page: a new render starts a new list. */
  readonly loadedAt: string;
}

/**
 * The library's recipes, 24 at a time with "Show more" (S24), read with the viewer's session.
 * Counts and pages cover only what they may see; drafts never appear here.
 */
export function RecipeResults({
  userId,
  homeId,
  initial,
  query,
  filtered,
  loadedAt,
}: RecipeResultsProps) {
  const t = useTranslations("Recipes");
  const pages = useInfiniteQuery({
    queryKey: recipeKeys.page(userId, homeId, query, loadedAt),
    initialPageParam: 0,
    initialData: { pages: [initial], pageParams: [0] },
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(query);
      if (homeId) params.set("homeId", homeId);
      params.set("offset", String(pageParam));
      return sendRecipeRequest<RecipePage>("GET", `${RECIPES_ENDPOINT}?${params.toString()}`);
    },
    getNextPageParam: (_last, all) => {
      const loaded = all.reduce((sum, page) => sum + page.recipes.length, 0);
      const total = all[0]?.total ?? 0;
      return loaded < total ? loaded : undefined;
    },
  });
  const recipes = pages.data.pages.flatMap((page) => page.recipes);
  const total = pages.data.pages[0]?.total ?? 0;

  return (
    <section aria-labelledby="recipe-results-heading" className="flex flex-col gap-4">
      <h2 id="recipe-results-heading" className="text-section-title font-semibold text-fg">
        {t("resultCount", { count: total })}
      </h2>
      {recipes.length === 0 ? (
        <EmptyState
          title={filtered ? t("noMatchesTitle") : t("emptyTitle")}
          description={filtered ? t("noMatches") : t("empty")}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="recipe-results">
          {recipes.map((recipe) => (
            <li key={recipe.id}>
              <RecipeCard recipe={recipe} homeId={homeId} />
            </li>
          ))}
        </ul>
      )}
      {pages.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            loading={pages.isFetchingNextPage}
            onClick={() => {
              void pages.fetchNextPage();
            }}
          >
            {t("showMore")}
          </Button>
        </div>
      ) : null}
      {pages.isFetchNextPageError ? (
        <p role="alert" className="text-body text-danger">
          {t("loadMoreFailed")}
        </p>
      ) : null}
    </section>
  );
}
