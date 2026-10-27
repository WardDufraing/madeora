import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { DraftPage } from "@/components/recipes/recipe-pages";
import { pageTitle } from "@/i18n/page-title";

interface RecipeDraftPageProps {
  readonly params: Promise<{ readonly draftId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recipes");
  return { title: await pageTitle(t("draftPageTitle")) };
}

/** One of the person's own drafts in the editor (S24); anyone else's is not found. */
export default async function RecipeDraftPage({ params }: RecipeDraftPageProps) {
  await requireIdentity();
  return <DraftPage draftId={(await params).draftId} />;
}
