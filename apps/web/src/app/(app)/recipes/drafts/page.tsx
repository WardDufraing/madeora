import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { DraftsPage } from "@/components/recipes/recipe-pages";
import { pageTitle } from "@/i18n/page-title";

interface RecipeDraftsPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("draftsTitle")) };
}

/** My drafts (S24): only the signed-in person's own. */
export default async function RecipeDraftsPage({ searchParams }: RecipeDraftsPageProps) {
  await requireIdentity();
  return <DraftsPage searchParams={await searchParams} />;
}
