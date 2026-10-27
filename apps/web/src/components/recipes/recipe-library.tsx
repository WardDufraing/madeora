import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { TaskNotice } from "@/components/tasks/task-notice";
import { ErrorState } from "@/components/ui/states";
import { getRecipeContext, listRecipes, listRecipeTags } from "@/recipes/data";
import { DRAFTS_PATH, newRecipePath, recipesPath } from "@/recipes/format";
import { parseRecipeQuery, recipeQueryString } from "@/recipes/schema";

import { primaryLinkClass } from "./link-styles";
import { RecipeFilters } from "./recipe-filters";
import { RecipeResults } from "./recipe-results";

export interface RecipeLibraryProps {
  readonly userId: string;
  /** `null`: the Personal space. */
  readonly home: { readonly id: string; readonly name: string } | null;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * The recipe library of one context (S24): its published recipes with search, tags, favorites and
 * sort, adding a recipe, and the way to the person's own drafts. Everything is read with the
 * viewer's session.
 */
export async function RecipeLibrary({ userId, home, searchParams }: RecipeLibraryProps) {
  const homeId = home?.id ?? null;
  const query = parseRecipeQuery(searchParams);
  const [t, context, tags, page] = await Promise.all([
    getTranslations("Recipes"),
    getRecipeContext(homeId),
    listRecipeTags(homeId),
    listRecipes(homeId, { ...query, offset: 0 }),
  ]);
  if (context.status !== "ok" || tags.status !== "ok" || page.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const base = recipesPath(homeId);
  const filtered = query.q.trim() !== "" || query.tags.length > 0 || query.favorites;
  const notice = searchParams.deleted === "1" ? "deleted" : null;

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home ? home.name : t("personalSpace")}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={DRAFTS_PATH} className="font-medium text-accent-fg underline">
          {t("myDraftsLink")}
        </Link>
      </p>
      {notice === "deleted" ? (
        <TaskNotice>
          {t("deletedNotice")}{" "}
          <Link
            href={home ? `/homes/${home.id}/trash` : "/settings/trash"}
            className="font-medium text-accent-fg underline"
          >
            {t("openTrash")}
          </Link>
        </TaskNotice>
      ) : null}
      <div className="flex flex-col gap-5">
        {context.value.canCreate ? (
          <div>
            <Link
              href={newRecipePath(homeId)}
              className={primaryLinkClass}
              data-testid="new-recipe"
            >
              {t("newRecipe")}
            </Link>
          </div>
        ) : null}
        <RecipeFilters action={base} query={query} tags={tags.value} filtered={filtered} />
        <RecipeResults
          userId={userId}
          homeId={homeId}
          initial={page.value}
          query={recipeQueryString(query)}
          filtered={filtered}
          loadedAt={new Date().toISOString()}
        />
      </div>
    </>
  );
}
