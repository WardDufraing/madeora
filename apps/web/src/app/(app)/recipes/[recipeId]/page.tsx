import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { RecipeDetailPage } from "@/components/recipes/recipe-detail";
import { pageTitle } from "@/i18n/page-title";

interface PersonalRecipePageProps {
  readonly params: Promise<{ readonly recipeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("recipePageTitle")) };
}

/** One recipe of the Personal space (S24). */
export default async function PersonalRecipePage({
  params,
  searchParams,
}: PersonalRecipePageProps) {
  await requireIdentity();
  const [{ recipeId }, query] = await Promise.all([params, searchParams]);
  return <RecipeDetailPage recipeId={recipeId} homeId={null} searchParams={query} />;
}
