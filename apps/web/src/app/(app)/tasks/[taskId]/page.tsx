import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { TaskDetailPage } from "@/components/tasks/task-detail";
import { pageTitle } from "@/i18n/page-title";

interface PersonalTaskPageProps {
  readonly params: Promise<{ readonly taskId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Tasks");
  return { title: await pageTitle(t("taskPageTitle")) };
}

/** One personal task (S18): only its owner can open it. */
export default async function PersonalTaskPage({ params }: PersonalTaskPageProps) {
  const { userId } = await requireIdentity();
  const { taskId } = await params;
  return <TaskDetailPage userId={userId} taskId={taskId} homeId={null} />;
}
