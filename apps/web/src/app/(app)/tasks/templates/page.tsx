import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { TaskTemplatesPage } from "@/components/tasks/task-templates-page";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("TaskTemplates");
  return { title: await pageTitle(t("pageTitle")) };
}

/** The Personal space's task templates (S19b). */
export default async function PersonalTaskTemplatesPage() {
  await requireIdentity();
  return <TaskTemplatesPage home={null} />;
}
