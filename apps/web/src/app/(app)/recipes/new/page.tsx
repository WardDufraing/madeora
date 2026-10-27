import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { NewRecipePage } from "@/components/recipes/recipe-pages";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("newRecipeTitle")) };
}

/** A new recipe started from the Personal space (S24). */
export default async function PersonalNewRecipePage() {
  await requireIdentity();
  return <NewRecipePage homeId={null} />;
}
