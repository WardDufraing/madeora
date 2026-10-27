import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { CookRecipePage } from "@/components/recipes/recipe-pages";
import { pageTitle } from "@/i18n/page-title";

interface PersonalRecipeCookPageProps {
  readonly params: Promise<{ readonly recipeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("cookingPageTitle")) };
}

/** Cooking mode of a Personal recipe (S24). */
export default async function PersonalRecipeCookPage({
  params,
  searchParams,
}: PersonalRecipeCookPageProps) {
  await requireIdentity();
  const [{ recipeId }, query] = await Promise.all([params, searchParams]);
  return <CookRecipePage recipeId={recipeId} homeId={null} searchParams={query} />;
}
