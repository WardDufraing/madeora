import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { getTaskContext, listTaskLabels, listTaskLists } from "@/tasks/data";
import { tasksPath } from "@/tasks/format";

import { ManageLabels, ManageLists } from "./task-manage";

/**
 * Lists and labels of one context (S18). Task managers only (the Personal space's owner; in a Home
 * the Owner and Administrators granted "Manage Home tasks"); anyone else is told so, and the
 * database refuses their changes anyway.
 */
export async function TaskManagePage({
  home,
}: {
  readonly home: { readonly id: string; readonly name: string } | null;
}) {
  const homeId = home?.id ?? null;
  const [t, context, lists, labels] = await Promise.all([
    getTranslations("Tasks"),
    getTaskContext(homeId),
    listTaskLists(homeId, true),
    listTaskLabels(homeId),
  ]);
  const base = tasksPath(homeId);
  const header = (
    <>
      <PageHeader title={t("manageTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home ? home.name : t("personalSpace")}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={base} className="font-medium text-accent-fg underline">
          {t("backToTasks")}
        </Link>
      </p>
    </>
  );
  if (context.status !== "ok" || lists.status !== "ok" || labels.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  if (!context.value.canManage) {
    return (
      <>
        {header}
        <EmptyState title={t("manageNotAllowedTitle")} description={t("manageNotAllowed")} />
      </>
    );
  }
  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-10">
        <ManageLists homeId={homeId} lists={lists.value} />
        <ManageLabels homeId={homeId} labels={labels.value} />
      </div>
    </>
  );
}
