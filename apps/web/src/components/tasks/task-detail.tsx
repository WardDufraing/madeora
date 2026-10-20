import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import {
  advanceSeries,
  getTask,
  listTaskComments,
  listTaskLabels,
  listTaskLists,
  listTaskMembers,
  listTaskOccurrences,
} from "@/tasks/data";
import { personName, memberNames, tasksPath, type MemberOption } from "@/tasks/format";

import { TaskAssignees } from "./task-assignees";
import { TaskComments } from "./task-comments";
import { TaskCompletion, TaskDelete, TaskMove } from "./task-actions";
import { TaskContent } from "./task-content";
import { TaskRepeats } from "./task-repeats";
import { TaskSubtasks } from "./task-subtasks";

export interface TaskDetailPageProps {
  readonly userId: string;
  readonly taskId: string;
  /** The context the address names; a task of another context is not found here. */
  readonly homeId: string | null;
}

/**
 * One task (S18): its status and completer, content, assignees (Home tasks), subtasks, comments and
 * basic activity (who created it and when, the last update). Everything is read with the viewer's
 * session; a task they cannot see, or one in another context than the address, is not found.
 * S19: an occurrence of a recurring series also shows the series (Repeats) and its history.
 */
export async function TaskDetailPage({ userId, taskId, homeId }: TaskDetailPageProps) {
  // S19: due occurrences of the context's series exist before the task is read.
  await advanceSeries(homeId);
  const [t, formats, task] = await Promise.all([
    getTranslations("Tasks"),
    getDateTimeFormats(),
    getTask(taskId),
  ]);
  if (task.status === "not-found") notFound();
  if (task.status === "unavailable") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  if (task.value.homeId !== homeId) notFound();
  const detail = task.value;
  const [lists, labels, members, comments, history] = await Promise.all([
    listTaskLists(homeId, false),
    listTaskLabels(homeId),
    homeId ? listTaskMembers(homeId) : Promise.resolve({ status: "ok", value: [] } as const),
    listTaskComments(detail.id, 0),
    detail.series
      ? listTaskOccurrences(detail.id, "all", 0)
      : Promise.resolve({ status: "ok", value: null } as const),
  ]);
  if (
    lists.status !== "ok" ||
    labels.status !== "ok" ||
    members.status !== "ok" ||
    comments.status !== "ok" ||
    history.status !== "ok"
  ) {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const memberOptions: readonly MemberOption[] = members.value;
  const names = memberNames(memberOptions);
  const who = (person: { readonly me: boolean; readonly member: string | null }) => {
    const name = personName(person, names);
    return name.kind === "me"
      ? t("personYou")
      : name.kind === "member"
        ? name.name
        : name.kind === "unnamed"
          ? t("personUnnamed")
          : t("personFormer");
  };
  const base = tasksPath(homeId);
  const loadedAt = new Date().toISOString();
  const series = detail.series;

  return (
    <>
      <PageHeader title={detail.title} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <Link href={base} className="font-medium text-accent-fg underline">
          {t("backToTasks")}
        </Link>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <span>
          {t("inList")}{" "}
          <Link
            href={`${base}?list=${detail.list.id}`}
            className="font-medium text-accent-fg underline"
          >
            <bdi>{detail.list.name}</bdi>
          </Link>
          {detail.list.archived ? ` (${t("archived")})` : null}
        </span>
      </p>
      <div className="flex max-w-3xl flex-col gap-8">
        <TaskCompletion task={detail} members={memberOptions} formats={formats} />
        <TaskContent
          task={detail}
          labels={labels.value.map(({ id, name, color }) => ({ id, name, color }))}
          dateFormat={formats.dateFormat}
        />
        {series && history.value ? (
          <TaskRepeats
            userId={userId}
            task={{ ...detail, series }}
            history={history.value}
            loadedAt={loadedAt}
            members={memberOptions}
            formats={formats}
          />
        ) : null}
        {homeId ? (
          <TaskAssignees task={detail} members={memberOptions} dateFormat={formats.dateFormat} />
        ) : null}
        <TaskSubtasks task={detail} />
        <TaskComments
          userId={userId}
          taskId={detail.id}
          initial={comments.value}
          loadedAt={loadedAt}
          members={memberOptions}
          formats={formats}
        />
        <section aria-labelledby="task-activity-heading" className="flex flex-col gap-2">
          <h2 id="task-activity-heading" className="text-section-title font-semibold text-fg">
            {t("activityHeading")}
          </h2>
          <dl className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-[max-content_1fr]">
            <dt className="font-medium text-fg">{t("activityCreated")}</dt>
            <dd className="text-fg">
              {t("activityBy", {
                person: who(detail.createdBy),
                date: formatDateTime(detail.createdAt, formats),
              })}
            </dd>
            <dt className="font-medium text-fg">{t("activityUpdated")}</dt>
            <dd className="text-fg">
              {t("activityBy", {
                person: who(detail.updatedBy),
                date: formatDateTime(detail.updatedAt, formats),
              })}
            </dd>
            <dt className="font-medium text-fg">{t("activityCompleted")}</dt>
            <dd className="text-fg">
              {detail.completedAt
                ? t("activityBy", {
                    person: detail.completedBy ? who(detail.completedBy) : t("personFormer"),
                    date: formatDateTime(detail.completedAt, formats),
                  })
                : t("notCompleted")}
            </dd>
            {detail.reopenedAt ? (
              <>
                <dt className="font-medium text-fg">{t("activityReopened")}</dt>
                <dd className="text-fg">
                  {t("activityBy", {
                    person: detail.reopenedBy ? who(detail.reopenedBy) : t("personFormer"),
                    date: formatDateTime(detail.reopenedAt, formats),
                  })}
                </dd>
              </>
            ) : null}
          </dl>
        </section>
        <TaskMove
          task={detail}
          lists={lists.value.map(({ id, name }) => ({ id, name }))}
          dateFormat={formats.dateFormat}
        />
        <TaskDelete task={detail} dateFormat={formats.dateFormat} />
      </div>
    </>
  );
}
