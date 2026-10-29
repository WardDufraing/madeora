import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { GoalsPage } from "@/components/goals/goals-page";
import { RememberContext } from "@/components/homes/remember-context";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Goals");
  return { title: await pageTitle(t("personalTitle")) };
}

/** The goals of the Personal space (S30): visible to their owner only. */
export default async function PersonalGoalsPage({ searchParams }: PageProps) {
  const { userId } = await requireIdentity();
  const params = await searchParams;
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <GoalsPage home={null} searchParams={params} />
    </>
  );
}
