import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { ImportRecipePage } from "@/components/recipes/recipe-pages";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeImportRecipePageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("importTitle")) };
}

/** Importing a recipe from a web page, started from a Home (S25): its default destination. */
export default async function HomeImportRecipePage({ params }: HomeImportRecipePageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <ImportRecipePage homeId={context.home.id} />
    </>
  );
}
