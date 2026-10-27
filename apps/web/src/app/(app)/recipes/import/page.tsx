import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { ImportRecipePage } from "@/components/recipes/recipe-pages";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("importTitle")) };
}

/** Importing a recipe from a web page, started from the Personal space (S25). */
export default async function PersonalImportRecipePage() {
  await requireIdentity();
  return <ImportRecipePage homeId={null} />;
}
