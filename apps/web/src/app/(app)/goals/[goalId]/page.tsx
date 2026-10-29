import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { GoalPage, goalPageTitle } from "@/components/goals/goal-page";

interface PageProps {
  readonly params: Promise<{ readonly goalId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = await getTranslations("Goals");
  return { title: await goalPageTitle((await params).goalId, t("goalFallbackTitle")) };
}

/** One personal goal (S30): its owner only; anything else is not found. */
export default async function PersonalGoalPage({ params }: PageProps) {
  await requireIdentity();
  const { goalId } = await params;
  return <GoalPage homeId={null} goalId={goalId} />;
}
