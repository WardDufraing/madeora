import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { HabitsPage } from "@/components/habits/habits-page";
import { RememberContext } from "@/components/homes/remember-context";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Habits");
  return { title: await pageTitle(t("personalTitle")) };
}

/** The habits of the Personal space (S28): visible to their owner only. */
export default async function PersonalHabitsPage({ searchParams }: PageProps) {
  const { userId } = await requireIdentity();
  const params = await searchParams;
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <HabitsPage home={null} searchParams={params} />
    </>
  );
}
