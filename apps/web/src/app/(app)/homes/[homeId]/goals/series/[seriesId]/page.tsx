import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { GoalSeriesPage, goalSeriesPageTitle } from "@/components/goals/goal-series-page";
import { loadHomeForPage } from "@/components/homes/home-page";
import { ErrorState } from "@/components/ui/states";

interface PageProps {
  readonly params: Promise<{ readonly homeId: string; readonly seriesId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = await getTranslations("Goals");
  return { title: await goalSeriesPageTitle((await params).seriesId, t("seriesFallbackTitle")) };
}

/** One recurring goal series of a Home (S30b), for its current members. */
export default async function HomeGoalSeriesPage({ params }: PageProps) {
  await requireIdentity();
  const { homeId, seriesId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return <GoalSeriesPage homeId={context.home.id} seriesId={seriesId} />;
}
