import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { RememberContext } from "@/components/homes/remember-context";
import { TasksOverview } from "@/components/tasks/tasks-overview";
import { pageTitle } from "@/i18n/page-title";

interface PersonalTasksPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Tasks");
  return { title: await pageTitle(t("personalPageTitle")) };
}

/** The Personal space's tasks (S18): visible to their owner only. */
export default async function PersonalTasksPage({ searchParams }: PersonalTasksPageProps) {
  const { userId } = await requireIdentity();
  const params = await searchParams;
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} clearParams={["deleted"]} />
      <TasksOverview
        userId={userId}
        home={null}
        searchParams={params}
        notice={params.deleted === "1" ? "deleted" : null}
      />
    </>
  );
}
