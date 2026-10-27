import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { RememberContext } from "@/components/homes/remember-context";
import { RecipeLibrary } from "@/components/recipes/recipe-library";
import { pageTitle } from "@/i18n/page-title";

interface PersonalRecipesPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("personalPageTitle")) };
}

/** The Personal space's recipes (S24): visible to their owner only. */
export default async function PersonalRecipesPage({ searchParams }: PersonalRecipesPageProps) {
  const { userId } = await requireIdentity();
  const params = await searchParams;
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} clearParams={["deleted"]} />
      <RecipeLibrary userId={userId} home={null} searchParams={params} />
    </>
  );
}
