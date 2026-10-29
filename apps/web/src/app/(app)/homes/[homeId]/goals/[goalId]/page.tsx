import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { GoalPage, goalPageTitle } from "@/components/goals/goal-page";
import { loadHomeForPage } from "@/components/homes/home-page";
import { ErrorState } from "@/components/ui/states";

interface PageProps {
  readonly params: Promise<{ readonly homeId: string; readonly goalId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = await getTranslations("Goals");
  return { title: await goalPageTitle((await params).goalId, t("goalFallbackTitle")) };
}

/** One goal of a Home (S30), for its current members; another Home's goal is not found here. */
export default async function HomeGoalPage({ params }: PageProps) {
  await requireIdentity();
  const { homeId, goalId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return <GoalPage homeId={context.home.id} goalId={goalId} />;
}
