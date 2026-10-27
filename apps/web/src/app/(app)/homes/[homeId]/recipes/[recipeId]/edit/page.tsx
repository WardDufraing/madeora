import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { EditRecipePage } from "@/components/recipes/recipe-pages";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeRecipeEditPageProps {
  readonly params: Promise<{ readonly homeId: string; readonly recipeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("editPageTitle")) };
}

/** Editing a Home recipe under its exclusive lock (S24). */
export default async function HomeRecipeEditPage({ params }: HomeRecipeEditPageProps) {
  const { userId } = await requireIdentity();
  const { homeId, recipeId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <EditRecipePage recipeId={recipeId} homeId={context.home.id} />
    </>
  );
}
