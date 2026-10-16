import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { TaskDetailPage } from "@/components/tasks/task-detail";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeTaskPageProps {
  readonly params: Promise<{ readonly homeId: string; readonly taskId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Tasks");
  return { title: await pageTitle(t("taskPageTitle")) };
}

/**
 * One Home task (S18). The Home is checked first: a Home the person is not in sends them to
 * Personal with the neutral notice; a task they cannot see, or of another Home, is not found.
 */
export default async function HomeTaskPage({ params }: HomeTaskPageProps) {
  const { userId } = await requireIdentity();
  const { homeId, taskId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <TaskDetailPage userId={userId} taskId={taskId} homeId={context.home.id} />
    </>
  );
}
