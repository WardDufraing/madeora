import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { TaskTemplatesPage } from "@/components/tasks/task-templates-page";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeTaskTemplatesPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("TaskTemplates");
  return { title: await pageTitle(t("pageTitle")) };
}

/** A Home's task templates (S19b): every member uses them, task managers manage them. */
export default async function HomeTaskTemplatesPage({ params }: HomeTaskTemplatesPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <TaskTemplatesPage home={{ id: context.home.id, name: context.home.name }} />
    </>
  );
}
