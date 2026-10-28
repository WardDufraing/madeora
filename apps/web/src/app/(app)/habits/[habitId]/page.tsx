import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { HabitPage, habitPageTitle } from "@/components/habits/habit-page";

interface PageProps {
  readonly params: Promise<{ readonly habitId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = await getTranslations("Habits");
  return { title: await habitPageTitle((await params).habitId, t("habitFallbackTitle")) };
}

/** One personal habit (S28): its owner only; anything else is not found. */
export default async function PersonalHabitPage({ params, searchParams }: PageProps) {
  await requireIdentity();
  const [{ habitId }, query] = await Promise.all([params, searchParams]);
  return <HabitPage homeId={null} habitId={habitId} searchParams={query} />;
}
