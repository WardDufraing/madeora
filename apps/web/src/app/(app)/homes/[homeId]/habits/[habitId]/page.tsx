import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { HabitPage, habitPageTitle } from "@/components/habits/habit-page";
import { loadHomeForPage } from "@/components/homes/home-page";
import { ErrorState } from "@/components/ui/states";

interface PageProps {
  readonly params: Promise<{ readonly homeId: string; readonly habitId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = await getTranslations("Habits");
  return { title: await habitPageTitle((await params).habitId, t("habitFallbackTitle")) };
}

/** One habit of a Home (S28), for its current members; another Home's habit is not found here. */
export default async function HomeHabitPage({ params, searchParams }: PageProps) {
  await requireIdentity();
  const [{ homeId, habitId }, query] = await Promise.all([params, searchParams]);
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return <HabitPage homeId={context.home.id} habitId={habitId} searchParams={query} />;
}
