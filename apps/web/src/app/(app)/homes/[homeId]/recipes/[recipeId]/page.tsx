import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { RecipeDetailPage } from "@/components/recipes/recipe-detail";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeRecipePageProps {
  readonly params: Promise<{ readonly homeId: string; readonly recipeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("recipePageTitle")) };
}

/** One recipe of a Home (S24). The Home is checked first; a recipe of another context is not found. */
export default async function HomeRecipePage({ params, searchParams }: HomeRecipePageProps) {
  const { userId } = await requireIdentity();
  const [{ homeId, recipeId }, query] = await Promise.all([params, searchParams]);
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <RecipeDetailPage recipeId={recipeId} homeId={context.home.id} searchParams={query} />
    </>
  );
}
