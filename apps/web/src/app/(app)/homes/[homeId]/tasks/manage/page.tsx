import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { TaskManagePage } from "@/components/tasks/task-manage-page";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeTaskManagePageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Tasks");
  return { title: await pageTitle(t("manageTitle")) };
}

/** A Home's task lists and labels (S18): task managers only. */
export default async function HomeTaskManagePage({ params }: HomeTaskManagePageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <TaskManagePage home={{ id: context.home.id, name: context.home.name }} />
    </>
  );
}
