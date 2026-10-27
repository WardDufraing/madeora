import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { CookRecipePage } from "@/components/recipes/recipe-pages";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeRecipeCookPageProps {
  readonly params: Promise<{ readonly homeId: string; readonly recipeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("cookingPageTitle")) };
}

/** Cooking mode of a Home recipe (S24). */
export default async function HomeRecipeCookPage({
  params,
  searchParams,
}: HomeRecipeCookPageProps) {
  const { userId } = await requireIdentity();
  const [{ homeId, recipeId }, query] = await Promise.all([params, searchParams]);
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <CookRecipePage recipeId={recipeId} homeId={context.home.id} searchParams={query} />
    </>
  );
}
