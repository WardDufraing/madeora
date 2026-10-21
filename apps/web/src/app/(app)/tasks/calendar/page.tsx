import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { RememberContext } from "@/components/homes/remember-context";
import { TaskCalendar } from "@/components/tasks/task-calendar";
import { pageTitle } from "@/i18n/page-title";

interface PersonalTaskCalendarPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("TaskCalendar");
  return { title: await pageTitle(t("pageTitle")) };
}

/** The Personal space's task calendar (S19c): visible to its owner only. */
export default async function PersonalTaskCalendarPage({
  searchParams,
}: PersonalTaskCalendarPageProps) {
  const { userId } = await requireIdentity();
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <TaskCalendar home={null} searchParams={await searchParams} />
    </>
  );
}
