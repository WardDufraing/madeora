import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { TaskManagePage } from "@/components/tasks/task-manage-page";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Tasks");
  return { title: await pageTitle(t("manageTitle")) };
}

/** The Personal space's task lists and labels (S18). */
export default async function PersonalTaskManagePage() {
  await requireIdentity();
  return <TaskManagePage home={null} />;
}
