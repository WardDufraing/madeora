import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { TasksOverview } from "@/components/tasks/tasks-overview";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";

interface HomeTasksPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: HomeTasksPageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Tasks"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("homePageTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

/**
 * A Home's tasks (S18). Every current member sees them; a Home the person is not (or no longer) in
 * sends them to Personal with one neutral notice, exactly like one that does not exist.
 */
export default async function HomeTasksPage({ params, searchParams }: HomeTasksPageProps) {
  const { userId } = await requireIdentity();
  const [{ homeId }, query] = await Promise.all([params, searchParams]);
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext
        userId={userId}
        context={{ kind: "home", homeId: context.home.id }}
        clearParams={["deleted"]}
      />
      <TasksOverview
        userId={userId}
        home={{ id: context.home.id, name: context.home.name }}
        searchParams={query}
        notice={query.deleted === "1" ? "deleted" : null}
      />
    </>
  );
}
