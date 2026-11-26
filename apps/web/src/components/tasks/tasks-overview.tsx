import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { z } from "zod";

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
import { groupQuery, parseTaskView, viewGroups, type TaskGroupId } from "@/tasks/views";

import { NewTask, type TaskCreation } from "./new-task";
import { TaskDetailPage } from "./task-detail";
import { TaskFilters } from "./task-filters";
import { TaskList } from "./task-list";
import { TaskListSwitcher } from "./task-list-switcher";
import { TaskNotice } from "./task-notice";
import { TaskPanel } from "./task-panel";
import { TaskViewSwitch } from "./task-view-switch";

export interface TasksOverviewProps {
  readonly userId: string;
  /** `null`: the Personal space. */
  readonly home: { readonly id: string; readonly name: string } | null;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
  /** A notice to show once, e.g. after a task was moved to the trash. */
  readonly notice: "deleted" | null;
}

const groupTitleKey = {
  overdue: "groupOverdue",
  today: "groupToday",
  undated: "groupNoDate",
  week: "groupWeek",
  later: "groupLater",
} as const satisfies Record<TaskGroupId, string>;

/**
 * The Tasks workspace of one context (S18, redesign UX4b): the page header with **+ New Task**, the
 * Today / Upcoming / All tasks / Lists views, the matching tasks, and the task side panel when
 * `?task=` names one. Everything is read with the viewer's session; the controls shown follow
 * their rights, which the database checks again on every change.
 */
export async function TasksOverview({ userId, home, searchParams, notice }: TasksOverviewProps) {
  const homeId = home?.id ?? null;
  const view = parseTaskView(searchParams);
  const query = parseTaskQuery(searchParams);
  const openTask = z.uuid().safeParse(searchParams.task);
  const taskId = openTask.success ? openTask.data : null;
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
  const { today, canManage } = context.value;
  const active = lists.value.filter((list) => !list.archived);
  const archived = lists.value.filter((list) => list.archived);
  const activeLists = active.map(({ id, name }) => ({ id, name }));
  // Lists: the chosen list, else the first one. Other views read every active list.
  const chosen = query.list ? lists.value.find((list) => list.id === query.list) : undefined;
  const current = view === "lists" ? (chosen ?? active[0]) : view === "all" ? chosen : undefined;
  const effectiveQuery = { ...query, list: current?.id };
  const memberOptions: readonly TaskMember[] = members.value;
  const labelOptions = labels.value.map(({ id, name, color }) => ({ id, name, color }));
  const creation = {
    lists: activeLists,
    defaultListId: current && !current.archived ? current.id : null,
    labels: labelOptions,
    members: canManage ? memberOptions : [],
    dateFormat: formats.dateFormat,
    canCreateList: canManage,
  };

  // The parameters a row keeps when it opens the side panel.
  const kept = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "task" || key === "deleted" || key === "offset" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) kept.append(key, item);
  }
  const panelQuery = kept.toString();
  const closeHref = panelQuery ? `${base}?${panelQuery}` : base;

  let content;
  if (view === "today" || view === "upcoming") {
    const groups = viewGroups[view];
    const pages = await Promise.all(
      groups.map((group) => listTasks(homeId, groupQuery(group.when))),
    );
    if (pages.some((page) => page.status !== "ok")) {
      return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
    }
    const loadedAt = new Date().toISOString();
    const empty = pages.every((page) => page.status === "ok" && page.value.total === 0);
    content =
      active.length === 0 ? (
        <NoLists canManage={canManage} creation={creation} homeId={homeId} />
      ) : view === "upcoming" && empty ? (
        <EmptyState title={t("upcomingEmptyTitle")} description={t("upcomingEmpty")} />
      ) : (
        groups.map((group, index) => {
          const page = pages[index];
          if (page?.status !== "ok") return null;
          const isToday = group.id === "today";
          return (
            <TaskList
              key={group.id}
              userId={userId}
              homeId={homeId}
              initial={page.value}
              query={taskQueryString(groupQuery(group.when))}
              loadedAt={loadedAt}
              labels={labelOptions}
              members={memberOptions}
              dateFormat={formats.dateFormat}
              showListName
              filtered={false}
              pageSize={TASK_LIMITS.page}
              heading={t(groupTitleKey[group.id])}
              today={today}
              panelQuery={panelQuery}
              selectedId={taskId}
              selectable={false}
              hideWhenEmpty={!isToday}
              creation={{ ...creation, ...(isToday ? { defaultDueDate: today } : {}) }}
            />
          );
        })
      );
  } else {
    const page = await listTasks(homeId, effectiveQuery);
    const completed =
      effectiveQuery.status === "open"
        ? await listTasks(homeId, { ...effectiveQuery, status: "completed", when: "any" })
        : null;
    if (page.status !== "ok" || (completed && completed.status !== "ok")) {
      return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
    }
    const filtered = hasTaskFilters(effectiveQuery);
    content =
      active.length === 0 ? (
        <NoLists canManage={canManage} creation={creation} homeId={homeId} />
      ) : (
        <>
          {view === "lists" ? (
            <div className="flex flex-col gap-3">
              <TaskListSwitcher
                homeId={homeId}
                lists={activeLists}
                current={current && !current.archived ? current.id : null}
                canCreate={canManage}
              />
              {archived.length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-body font-medium text-fg">
                    {t("archivedLists", { count: archived.length })}
                  </summary>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {archived.map((list) => (
                      <li key={list.id}>
                        <Link
                          href={`${base}?view=lists&list=${list.id}`}
                          aria-current={current?.id === list.id ? "page" : undefined}
                          className={cx(
                            "inline-flex min-h-10 items-center gap-2 rounded-control px-3 text-body",
                            current?.id === list.id
                              ? "bg-accent-subtle font-semibold text-fg"
                              : "text-fg hover:bg-accent-subtle",
                          )}
                        >
                          <bdi>{list.name}</bdi>
                          <span className="text-helper text-fg-muted">{t("archived")}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}
          {current?.archived ? (
            <p className="text-body text-fg-muted">{t("archivedListNotice")}</p>
          ) : null}
          <TaskFilters
            action={base}
            query={effectiveQuery}
            labels={labelOptions}
            members={memberOptions}
            isHome={homeId !== null}
            filtered={filtered}
            view={view}
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
            moveLists={activeLists}
            heading={current ? current.name : t("allTasks")}
            today={today}
            panelQuery={panelQuery}
            selectedId={taskId}
            {...(current?.archived ? {} : { creation })}
            {...(completed?.status === "ok" ? { completed: completed.value } : {})}
          />
        </>
      );
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-page-title font-semibold">{t("title")}</h1>
        {current?.archived ? null : (
          <NewTask
            homeId={homeId}
            lists={activeLists}
            defaultListId={current?.id ?? null}
            labels={labelOptions}
            members={canManage ? memberOptions : []}
            dateFormat={formats.dateFormat}
            templates={templates.value}
            canCreateList={canManage}
          />
        )}
      </div>
      <p className="mb-4 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home ? home.name : t("personalSpace")}</bdi>
        {canManage ? (
          <>
            <span aria-hidden="true">{"\u{00B7}"}</span>
            <Link href={`${base}/manage`} className="link-action">
              {t("manageLink")}
            </Link>
          </>
        ) : null}
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`${base}/templates`} className="link-action">
          {tTemplates("libraryLink")}
        </Link>
      </p>
      <TaskViewSwitch homeId={homeId} current={view} list={current?.id} />
      {notice === "deleted" ? (
        <TaskNotice>
          {t("deletedNotice")}{" "}
          <Link href={home ? `/homes/${home.id}/trash` : "/settings/trash"} className="link-inline">
            {t("openTrash")}
          </Link>
        </TaskNotice>
      ) : null}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-6">{content}</div>
        {taskId ? (
          <TaskPanel
            taskId={taskId}
            closeHref={closeHref}
            closeLabel={t("closePanel")}
            label={t("taskPanelLabel")}
          >
            <TaskDetailPage userId={userId} taskId={taskId} homeId={homeId} variant="panel" />
          </TaskPanel>
        ) : null}
      </div>
    </>
  );
}

/** No list yet: **+ New Task** still works (it offers to create the first list with the task). */
async function NoLists({
  canManage,
  creation,
  homeId,
}: {
  readonly canManage: boolean;
  readonly creation: TaskCreation;
  readonly homeId: string | null;
}) {
  const t = await getTranslations("Tasks");
  return (
    <EmptyState
      title={t("noListsTitle")}
      description={canManage ? t("noListsManager") : t("noListsMember")}
      action={
        canManage ? (
          <NewTask
            {...creation}
            homeId={homeId}
            placement="inline"
            triggerLabel={t("addFirstTask")}
          />
        ) : undefined
      }
    />
  );
}
