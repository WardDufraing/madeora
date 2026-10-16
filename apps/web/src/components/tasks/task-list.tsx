"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/states";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { isolate } from "@/invitations/format";
import {
  sendTaskRequest,
  TASKS_ENDPOINT,
  taskListingUrl,
  type CompletionResponse,
  type TaskPage,
  type TaskRow,
} from "@/tasks/api";
import {
  formatTaskDate,
  memberNames,
  taskKeys,
  tasksPath,
  type MemberOption,
} from "@/tasks/format";
import type { DateFormat } from "@/preferences/schema";

import { LabelChip } from "./label-chip";
import type { LabelOption } from "./label-picker";
import { HydrationGate } from "./hydration-gate";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

export interface TaskListProps {
  readonly userId: string;
  readonly homeId: string | null;
  /** The first page, rendered by the server. */
  readonly initial: TaskPage;
  /** The page's filters as a query string (without offset), for loading more. */
  readonly query: string;
  /** When the server rendered this page: a refresh starts a new set of pages. */
  readonly loadedAt: string;
  readonly labels: readonly LabelOption[];
  readonly members: readonly MemberOption[];
  readonly dateFormat: DateFormat;
  /** All Tasks: name each task's list. */
  readonly showListName: boolean;
  readonly filtered: boolean;
  readonly pageSize: number;
}

/**
 * The tasks of one list or of All Tasks (S18), 50 at a time with "Show more" (S17 review M2: no
 * page loads more than it shows). Each row shows its dates, priority, labels and assignees as text,
 * never colour alone, and offers the shared completion checkbox when the viewer may complete it.
 */
export function TaskList({
  userId,
  homeId,
  initial,
  query,
  loadedAt,
  labels,
  members,
  dateFormat,
  showListName,
  filtered,
  pageSize,
}: TaskListProps) {
  const t = useTranslations("Tasks");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useTaskTexts(names);
  const labelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [confirming, setConfirming] = useState<TaskRow | null>(null);
  const { announce, region } = useAnnouncer();

  const pages = useInfiniteQuery({
    queryKey: taskKeys.page(userId, homeId, query, loadedAt),
    initialPageParam: 0,
    initialData: { pages: [initial], pageParams: [0] },
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(query);
      params.set("offset", String(pageParam));
      return sendTaskRequest<TaskPage>("GET", taskListingUrl(homeId, params));
    },
    getNextPageParam: (_last, all) => {
      const loaded = all.reduce((sum, page) => sum + page.tasks.length, 0);
      const total = all[0]?.total ?? 0;
      return loaded < total ? loaded : undefined;
    },
  });
  const rows = pages.data.pages.flatMap((page) => page.tasks);
  const total = pages.data.pages[0]?.total ?? 0;

  // What the person just ticked, shown at once until the refreshed page confirms it; a refusal
  // puts the box back (no state is invented: the server's answer replaces it on refresh).
  // Kept per server render: a new render (after the refresh) starts from the server's state.
  const [tickedState, setTickedState] = useState<{
    readonly loadedAt: string;
    readonly map: ReadonlyMap<string, boolean>;
  }>({ loadedAt, map: new Map() });
  const ticked = tickedState.loadedAt === loadedAt ? tickedState.map : new Map<string, boolean>();
  const setTicked = (update: (previous: ReadonlyMap<string, boolean>) => Map<string, boolean>) => {
    setTickedState((previous) => ({
      loadedAt,
      map: update(previous.loadedAt === loadedAt ? previous.map : new Map()),
    }));
  };
  const completion = useTaskMutation(
    `task-list-completion:${homeId ?? "personal"}`,
    ({ task, completed }: { readonly task: TaskRow; readonly completed: boolean }) =>
      sendTaskRequest<CompletionResponse>("PUT", `${TASKS_ENDPOINT}/${task.id}/completion`, {
        completed,
      }),
    (result, { task }) => {
      const title = isolate(task.title);
      if (result.outcome === "already_completed" && result.completedBy && !result.completedBy.me) {
        announce(
          t("announceAlreadyCompleted", { task: title, person: texts.person(result.completedBy) }),
        );
      } else {
        announce(
          result.outcome === "completed" || result.outcome === "already_completed"
            ? t("announceCompleted", { task: title })
            : t("announceReopened", { task: title }),
        );
      }
      // The row may leave this view (open tasks only): keep the keyboard on the list (S17 M3).
      headingRef.current?.focus();
    },
    ({ task }) => {
      setTicked((previous) => {
        const next = new Map(previous);
        next.delete(task.id);
        return next;
      });
    },
  );

  function complete(task: TaskRow, completed: boolean) {
    setTicked((previous) => new Map(previous).set(task.id, completed));
    completion.mutate({ task, completed });
  }

  return (
    <section
      aria-labelledby="task-list-heading"
      className="flex flex-col gap-3"
      data-testid="task-list"
    >
      <HydrationGate>
        {region}
        <h2
          id="task-list-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-section-title font-semibold text-fg outline-none"
        >
          {t("listCount", { count: total })}
        </h2>
        {completion.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(completion.error.failure)}
          </FormAlert>
        ) : null}
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? t("emptyFilteredTitle") : t("emptyTitle")}
            description={filtered ? t("emptyFiltered") : t("empty")}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((task) => (
              <li
                key={task.id}
                className="flex items-start gap-3 rounded-control border border-line bg-surface p-3"
                data-testid="task-row"
              >
                {task.canComplete ? (
                  <Checkbox
                    label={t("completeTask", { task: task.title })}
                    className="mt-0.5 [&_label]:sr-only"
                    checked={ticked.get(task.id) ?? task.completed}
                    disabled={completion.busy}
                    onChange={(event) => {
                      const completed = event.target.checked;
                      // Unfinished subtasks: ask first, like the task page (spec).
                      if (completed && task.subtasksDone < task.subtasksTotal) {
                        setConfirming(task);
                        return;
                      }
                      complete(task, completed);
                    }}
                  />
                ) : (
                  <span className="mt-0.5 text-helper text-fg-muted">
                    {task.completed ? t("statusDone") : t("statusOpen")}
                  </span>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Link
                    href={`${tasksPath(homeId)}/${task.id}`}
                    className={`font-medium text-fg underline-offset-2 hover:underline ${task.completed ? "line-through" : ""}`}
                  >
                    <bdi>{task.title}</bdi>
                  </Link>
                  <p className="flex flex-wrap gap-x-3 gap-y-1 text-helper text-fg-muted">
                    {task.completed ? <span>{t("statusCompleted")}</span> : null}
                    {showListName ? (
                      <span>
                        {t("inList")} <bdi>{task.listName}</bdi>
                      </span>
                    ) : null}
                    {task.dueDate ? (
                      <span className={task.overdue ? "font-semibold text-danger" : undefined}>
                        {task.overdue
                          ? t("dueOverdue", { date: formatTaskDate(task.dueDate, { dateFormat }) })
                          : t("dueOn", { date: formatTaskDate(task.dueDate, { dateFormat }) })}
                      </span>
                    ) : null}
                    {task.startDate && task.upcoming ? (
                      <span>
                        {t("startsOn", { date: formatTaskDate(task.startDate, { dateFormat }) })}
                      </span>
                    ) : null}
                    {task.priority && task.priority !== "normal" ? (
                      <span>{t("priorityShown", { priority: texts.priority(task.priority) })}</span>
                    ) : null}
                    {task.subtasksTotal > 0 ? (
                      <span>
                        {t("subtaskProgress", {
                          done: task.subtasksDone,
                          total: task.subtasksTotal,
                        })}
                      </span>
                    ) : null}
                    {task.commentCount > 0 ? (
                      <span>{t("commentCount", { count: task.commentCount })}</span>
                    ) : null}
                    {homeId && task.assigneeIds.length > 0 ? (
                      <span>
                        {t("assignedTo", {
                          people: task.assigneeIds.map((id) => texts.member(id)).join(", "),
                        })}
                      </span>
                    ) : null}
                    {task.needsReassignment ? (
                      <span className="font-semibold text-warning">{t("needsReassignment")}</span>
                    ) : null}
                  </p>
                  {task.labelIds.length > 0 ? (
                    <ul className="flex flex-wrap gap-1.5" aria-label={t("fieldLabels")}>
                      {task.labelIds.map((id) => {
                        const label = labelsById.get(id);
                        return label ? (
                          <li key={id}>
                            <LabelChip name={label.name} color={label.color} />
                          </li>
                        ) : null;
                      })}
                    </ul>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {pages.hasNextPage ? (
          <div>
            <Button
              variant="secondary"
              loading={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
              data-testid="tasks-more"
            >
              {t("showMore", { count: Math.min(pageSize, total - rows.length) })}
            </Button>
          </div>
        ) : null}
        {pages.isFetchNextPageError ? (
          <FormAlert tone="error" announce>
            {t("moreFailed")}
          </FormAlert>
        ) : null}
        <Dialog
          open={confirming !== null}
          onClose={() => {
            // Focus returns to the checkbox, which stays unticked.
            setConfirming(null);
          }}
          title={t("confirmCompleteTitle")}
          description={
            confirming
              ? t("confirmCompleteBody", {
                  count: confirming.subtasksTotal - confirming.subtasksDone,
                })
              : ""
          }
          closeLabel={t("close")}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirming(null);
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={() => {
                  const task = confirming;
                  setConfirming(null);
                  if (task) complete(task, true);
                }}
                data-testid="task-list-confirm-complete"
              >
                {t("markComplete")}
              </Button>
            </>
          }
        />
      </HydrationGate>
    </section>
  );
}
