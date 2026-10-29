import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { GoalSeriesPage, goalSeriesPageTitle } from "@/components/goals/goal-series-page";

interface PageProps {
  readonly params: Promise<{ readonly seriesId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = await getTranslations("Goals");
  return { title: await goalSeriesPageTitle((await params).seriesId, t("seriesFallbackTitle")) };
}

/** One personal recurring goal series (S30b): its owner only; anything else is not found. */
export default async function PersonalGoalSeriesPage({ params }: PageProps) {
  await requireIdentity();
  const { seriesId } = await params;
  return <GoalSeriesPage homeId={null} seriesId={seriesId} />;
}
