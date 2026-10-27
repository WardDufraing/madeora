import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { ShareRecipePage } from "@/components/recipes/recipe-pages";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeRecipeSharePageProps {
  readonly params: Promise<{ readonly homeId: string; readonly recipeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("sharePageTitle")) };
}

/** Where a Home's recipe is shared (S25): for its recipe managers. */
export default async function HomeRecipeSharePage({ params }: HomeRecipeSharePageProps) {
  const { userId } = await requireIdentity();
  const { homeId, recipeId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <ShareRecipePage recipeId={recipeId} homeId={context.home.id} />
    </>
  );
}
