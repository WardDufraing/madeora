import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { ShareRecipePage } from "@/components/recipes/recipe-pages";
import { pageTitle } from "@/i18n/page-title";

interface PersonalRecipeSharePageProps {
  readonly params: Promise<{ readonly recipeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("sharePageTitle")) };
}

/** Where a Personal recipe is shared (S25). */
export default async function PersonalRecipeSharePage({ params }: PersonalRecipeSharePageProps) {
  await requireIdentity();
  const { recipeId } = await params;
  return <ShareRecipePage recipeId={recipeId} homeId={null} />;
}
