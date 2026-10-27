import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { ErrorState } from "@/components/ui/states";
import type { WidgetConfigs } from "@/dashboard/widgets";
import { readRecipeWidget } from "@/recipes/data";
import { newRecipePath, recipesPath } from "@/recipes/format";

import { RecipeWidgetCards } from "./recipe-widget-cards";

/**
 * A Recipes widget (S24): the viewer's favorites, recently added, highest rated or one random
 * recipe of its context, read with the viewer's session. Random starts from a seed held by the
 * widget (its id), so the pick changes only on Show another.
 */
export async function RecipesWidget({
  homeId,
  widgetId,
  config,
}: {
  readonly homeId: string | null;
  readonly widgetId: string;
  readonly config: WidgetConfigs["recipes"];
}) {
  const count = config.mode === "random" ? 1 : config.count;
  const [t, data] = await Promise.all([
    getTranslations("RecipeWidgets"),
    readRecipeWidget(homeId, config.mode, count, config.mode === "random" ? widgetId : null),
  ]);
  if (data.status !== "ok") {
    return <ErrorState title={t("failedTitle")} description={t("failed")} />;
  }
  return (
    <div className="flex flex-col gap-3" data-testid="recipe-widget">
      <RecipeWidgetCards
        homeId={homeId}
        mode={config.mode}
        count={count}
        seed={widgetId}
        initial={data.value}
      />
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        <Link href={recipesPath(homeId)} className="text-body font-medium text-accent-fg underline">
          {t("openLibrary")}
        </Link>
        {data.value.available === 0 && config.mode === "recent" ? (
          <Link
            href={newRecipePath(homeId)}
            className="text-body font-medium text-accent-fg underline"
          >
            {t("addRecipe")}
          </Link>
        ) : null}
      </p>
    </div>
  );
}
