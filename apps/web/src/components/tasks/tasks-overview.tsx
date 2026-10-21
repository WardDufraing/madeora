import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { cx } from "@/components/ui/cx";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { getDateTimeFormats } from "@/invitations/server";
import {
  advanceSeries,
  getTaskContext,
  listTaskLabels,
  listTaskLists,
  listTaskMembers,
  listTasks,
  type TaskMember,
} from "@/tasks/data";
import { listTaskTemplates } from "@/tasks/template-data";
import { hasTaskFilters, parseTaskQuery, taskQueryString } from "@/tasks/filters";
import { tasksPath } from "@/tasks/format";
import { TASK_LIMITS } from "@/tasks/schema";

import { NewTask } from "./new-task";
import { TaskFilters } from "./task-filters";
import { TaskList } from "./task-list";
import { TaskNotice } from "./task-notice";
import { TaskViewSwitch } from "./task-view-switch";

export interface TasksOverviewProps {
  readonly userId: string;
  /** `null`: the Personal space. */
  readonly home: { readonly id: string; readonly name: string } | null;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
  /** A notice to show once, e.g. after a task was moved to the trash. */
  readonly notice: "deleted" | null;
}

/**
 * The Tasks page of one context (S18): its lists and All Tasks, filters, adding a task, and the
 * matching tasks. Everything is read with the viewer's session; the controls shown follow their
 * rights, which the database checks again on every change.
 */
export async function TasksOverview({ userId, home, searchParams, notice }: TasksOverviewProps) {
  const homeId = home?.id ?? null;
  const query = parseTaskQuery(searchParams);
  // S19: recurring series create their due occurrences before anything is read.
  await advanceSeries(homeId);
  const [t, tTemplates, formats, context, lists, labels, members, templates] = await Promise.all([
    getTranslations("Tasks"),
    getTranslations("TaskTemplates"),
    getDateTimeFormats(),
    getTaskContext(homeId),
    listTaskLists(homeId, true),
    listTaskLabels(homeId),
    homeId ? listTaskMembers(homeId) : Promise.resolve({ status: "ok", value: [] } as const),
    listTaskTemplates(homeId),
  ]);
  if (
    context.status !== "ok" ||
    lists.status !== "ok" ||
    labels.status !== "ok" ||
    members.status !== "ok" ||
    templates.status !== "ok"
  ) {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }

  const base = tasksPath(homeId);
  const active = lists.value.filter((list) => !list.archived);
  const archived = lists.value.filter((list) => list.archived);
  const current = query.list ? lists.value.find((list) => list.id === query.list) : undefined;
  const effectiveQuery = current ? query : { ...query, list: undefined };
  const page = await listTasks(homeId, effectiveQuery);
  if (page.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const memberOptions: readonly TaskMember[] = members.value;
  const labelOptions = labels.value.map(({ id, name, color }) => ({ id, name, color }));
  const filtered = hasTaskFilters(effectiveQuery);

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home ? home.name : t("personalSpace")}</bdi>
        {context.value.canManage ? (
          <>
            <span aria-hidden="true">{"\u{00B7}"}</span>
            <Link href={`${base}/manage`} className="font-medium text-accent-fg underline">
              {t("manageLink")}
            </Link>
          </>
        ) : null}
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`${base}/templates`} className="font-medium text-accent-fg underline">
          {tTemplates("libraryLink")}
        </Link>
      </p>
      <TaskViewSwitch homeId={homeId} current="list" list={current?.id} />
      {notice === "deleted" ? (
        <TaskNotice>
          {t("deletedNotice")}{" "}
          <Link
            href={home ? `/homes/${home.id}/trash` : "/settings/trash"}
            className="font-medium text-accent-fg underline"
          >
            {t("openTrash")}
          </Link>
        </TaskNotice>
      ) : null}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <nav
          aria-label={t("listsNav")}
          className="lg:w-64 lg:shrink-0"
          data-testid="task-lists-nav"
        >
          <ul className="flex flex-col gap-1">
            <li>
              <ListLink href={base} current={!current} label={t("allTasks")} />
            </li>
            {active.map((list) => (
              <li key={list.id}>
                <ListLink
                  href={`${base}?list=${list.id}`}
                  current={current?.id === list.id}
                  label={list.name}
                  count={t("openCount", { count: list.openTasks })}
                />
              </li>
            ))}
          </ul>
          {archived.length > 0 ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-body font-medium text-fg">
                {t("archivedLists", { count: archived.length })}
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {archived.map((list) => (
                  <li key={list.id}>
                    <ListLink
                      href={`${base}?list=${list.id}`}
                      current={current?.id === list.id}
                      label={list.name}
                      count={t("archived")}
                    />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-5">
          {active.length === 0 ? (
            <EmptyState
              title={t("noListsTitle")}
              description={context.value.canManage ? t("noListsManager") : t("noListsMember")}
            />
          ) : current?.archived ? (
            <p className="text-body text-fg-muted">{t("archivedListNotice")}</p>
          ) : (
            <NewTask
              homeId={homeId}
              lists={active.map(({ id, name }) => ({ id, name }))}
              defaultListId={current?.id ?? null}
              labels={labelOptions}
              members={context.value.canManage ? memberOptions : []}
              dateFormat={formats.dateFormat}
              templates={templates.value}
            />
          )}
          <h2 className="sr-only">{current ? current.name : t("allTasks")}</h2>
          <p className="text-body text-fg-muted">
            {current ? (
              <>
                {t("viewingList")} <bdi className="font-semibold text-fg">{current.name}</bdi>
              </>
            ) : (
              t("viewingAll")
            )}
          </p>
          <TaskFilters
            action={base}
            query={effectiveQuery}
            labels={labelOptions}
            members={memberOptions}
            isHome={homeId !== null}
            filtered={filtered}
          />
          <TaskList
            userId={userId}
            homeId={homeId}
            initial={page.value}
            query={taskQueryString(effectiveQuery)}
            loadedAt={new Date().toISOString()}
            labels={labelOptions}
            members={memberOptions}
            dateFormat={formats.dateFormat}
            showListName={!current}
            filtered={filtered}
            pageSize={TASK_LIMITS.page}
            moveLists={active.map(({ id, name }) => ({ id, name }))}
          />
        </div>
      </div>
    </>
  );
}

function ListLink({
  href,
  current,
  label,
  count,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly label: string;
  readonly count?: string;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cx(
        "flex min-h-10 items-center justify-between gap-2 rounded-control px-3 text-body",
        current ? "bg-accent-subtle font-semibold text-fg" : "text-fg hover:bg-accent-subtle",
      )}
    >
      <bdi className="truncate">{label}</bdi>
      {count ? <span className="shrink-0 text-helper text-fg-muted">{count}</span> : null}
    </Link>
  );
}
