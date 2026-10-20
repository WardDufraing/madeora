import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { getTaskContext, listTaskLabels } from "@/tasks/data";
import { tasksPath } from "@/tasks/format";
import { listTaskTemplates } from "@/tasks/template-data";

import { TemplateLibrary } from "./task-templates";

/**
 * The task templates of one context (S19b). Every member sees them; task managers (the Personal
 * space's owner; in a Home the Owner and Administrators granted "Manage Home tasks") manage them,
 * and the database refuses anyone else's changes.
 */
export async function TaskTemplatesPage({
  home,
}: {
  readonly home: { readonly id: string; readonly name: string } | null;
}) {
  const homeId = home?.id ?? null;
  const [t, tTasks, context, templates, labels] = await Promise.all([
    getTranslations("TaskTemplates"),
    getTranslations("Tasks"),
    getTaskContext(homeId),
    listTaskTemplates(homeId),
    listTaskLabels(homeId),
  ]);
  const header = (
    <>
      <PageHeader title={t("pageTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home ? home.name : tTasks("personalSpace")}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={tasksPath(homeId)} className="font-medium text-accent-fg underline">
          {tTasks("backToTasks")}
        </Link>
      </p>
    </>
  );
  if (context.status !== "ok" || templates.status !== "ok" || labels.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={tTasks("loadFailedTitle")} description={tTasks("loadFailed")} />
      </>
    );
  }
  return (
    <>
      {header}
      <div className="max-w-3xl">
        <TemplateLibrary
          homeId={homeId}
          templates={templates.value}
          labels={labels.value.map(({ id, name, color }) => ({ id, name, color }))}
          canManage={context.value.canManage}
        />
      </div>
    </>
  );
}
