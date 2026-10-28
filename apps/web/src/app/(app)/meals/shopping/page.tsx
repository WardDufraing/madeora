import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { RememberContext } from "@/components/homes/remember-context";
import { MealsPage } from "@/components/meals/meals-page";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Meals");
  return { title: await pageTitle(t("transferPageTitle", { home: t("personalSpace") })) };
}

/** Add the meal plan's ingredients to a shopping list of the Personal space (S27): visible to its owner only. */
export default async function PersonalMealsShoppingPage({ searchParams }: PageProps) {
  const { userId } = await requireIdentity();
  const params = await searchParams;
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <MealsPage home={null} kind="shopping" searchParams={params} />
    </>
  );
}
