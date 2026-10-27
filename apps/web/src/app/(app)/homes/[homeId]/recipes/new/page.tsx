import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { NewRecipePage } from "@/components/recipes/recipe-pages";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeNewRecipePageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("newRecipeTitle")) };
}

/** A new recipe started from a Home (S24): the Home is its default destination. */
export default async function HomeNewRecipePage({ params }: HomeNewRecipePageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <NewRecipePage homeId={context.home.id} />
    </>
  );
}
