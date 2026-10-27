import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { EditRecipePage } from "@/components/recipes/recipe-pages";
import { pageTitle } from "@/i18n/page-title";

interface PersonalRecipeEditPageProps {
  readonly params: Promise<{ readonly recipeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("editPageTitle")) };
}

/** Editing a recipe of the Personal space under its lock (S24). */
export default async function PersonalRecipeEditPage({ params }: PersonalRecipeEditPageProps) {
  await requireIdentity();
  const { recipeId } = await params;
  return <EditRecipePage recipeId={recipeId} homeId={null} />;
}
