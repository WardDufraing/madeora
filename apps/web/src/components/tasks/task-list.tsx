"use client";

import { ChevronDownIcon, RepeatIcon, WarningIcon } from "@madeora/icons";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cx } from "@/components/ui/cx";
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
import { TASK_LIMITS, type TaskPriority } from "@/tasks/schema";
import { daysOverdue, SIGNIFICANTLY_OVERDUE_DAYS } from "@/tasks/views";

import { BulkBar } from "./bulk-actions";
import { LabelChip } from "./label-chip";
import { NewTask, type TaskCreation } from "./new-task";
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
  /** S19b: the context's active lists, the targets of a bulk move. */
  readonly moveLists?: readonly { readonly id: string; readonly name: string }[];
  /** UX4b: a named group of a view (Overdue, Today, ...); without it the list names itself. */
  readonly heading?: string;
  /** Today in the context's timezone, for "Overdue · N days" and "Due today". */
  readonly today?: string;
  /** The page's other parameters (view, list, filters), kept when a row opens the side panel. */
  readonly panelQuery?: string;
  /** The task open in the side panel, marked in its row. */
  readonly selectedId?: string | null;
  /** Bulk selection is for the All and Lists views, not for the Today and Upcoming groups. */
  readonly selectable?: boolean;
  /** Nothing to show: draw nothing for a group that is empty (its siblings explain the view). */
  readonly hideWhenEmpty?: boolean;
  /** The inline "Add a task" of this group; without it the group has none. */
  readonly creation?: TaskCreation;
  /** The first page of completed tasks of this scope, for the collapsed Completed section. */
  readonly completed?: TaskPage;
}

/** How long a task just completed stays where it was, so the feedback is seen and undo is easy. */
const RETAIN_MS = 4000;

interface Finished {
  readonly task: TaskRow;
  readonly index: number;
  readonly at: number;
  readonly settled: boolean;
}

const priorityBar: Partial<Record<TaskPriority, string>> = {
  urgent: "w-1.5 bg-priority-high",
  high: "w-1 bg-priority-high",
  low: "w-1 bg-priority-low",
};

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
  moveLists = [],
  heading,
  today,
  panelQuery = "",
  selectedId = null,
  selectable = true,
  hideWhenEmpty = false,
  creation,
  completed,
}: TaskListProps) {
  const t = useTranslations("Tasks");
  const tBulk = useTranslations("TaskBulk");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useTaskTexts(names);
  const labelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const [showCompleted, setShowCompleted] = useState(false);
  const [finished, setFinished] = useState<readonly Finished[]>([]);
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
  const serverRows = pages.data.pages.flatMap((page) => page.tasks);
  const serverTotal = pages.data.pages[0]?.total ?? 0;

  // Tasks completed during this visit stay where they were for a moment (feedback, easy undo),
  // then move to the collapsed Completed section. The server's refreshed page no longer lists
  // them as open, so they are kept here.
  const finishedById = new Map(finished.map((entry) => [entry.task.id, entry]));
  const serverIds = new Set(serverRows.map((row) => row.id));
  const rows: TaskRow[] = serverRows.filter((row) => !finishedById.get(row.id)?.settled);
  for (const entry of [...finished].sort((a, b) => a.index - b.index)) {
    if (entry.settled || serverIds.has(entry.task.id)) continue;
    rows.splice(Math.min(entry.index, rows.length), 0, { ...entry.task, completed: true });
  }
  const total = Math.max(0, serverTotal - finished.filter((e) => serverIds.has(e.task.id)).length);

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
    `task-list-completion:${homeId ?? "personal"}:${headingId}`,
    ({
      task,
      completed: done,
    }: {
      readonly task: TaskRow;
      readonly completed: boolean;
      readonly index: number;
    }) =>
      sendTaskRequest<CompletionResponse>("PUT", `${TASKS_ENDPOINT}/${task.id}/completion`, {
        completed: done,
      }),
    (result, { task, completed: done, index }) => {
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
      // Focus stays where it is: the row does not move at once (decision 50, no jumps).
      setFinished((previous) => {
        const others = previous.filter((entry) => entry.task.id !== task.id);
        return done
          ? [
              ...others,
              { task: { ...task, completed: true }, index, at: Date.now(), settled: false },
            ]
          : others;
      });
    },
    ({ task }) => {
      setTicked((previous) => {
        const next = new Map(previous);
        next.delete(task.id);
        return next;
      });
    },
  );

  // Move retained rows into the Completed section after a pause, but never while the person is
  // in that row or has the task open in the side panel (no rows jumping under the keyboard).
  const waiting = finished.some((entry) => !entry.settled);
  useEffect(() => {
    if (!waiting || selectedId !== null) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setFinished((previous) =>
        previous.map((entry) => {
          if (entry.settled || now - entry.at < RETAIN_MS) return entry;
          const row = document.querySelector(`[data-task-id="${entry.task.id}"]`);
          if (row?.contains(document.activeElement)) return entry;
          return { ...entry, settled: true };
        }),
      );
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [waiting, selectedId]);

  // S19b select mode. The selection belongs to the filters it was made under: changing them
  // (a new query) clears it, so nothing hidden by a filter stays selected.
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<{
    readonly query: string;
    readonly ids: ReadonlySet<string>;
  }>({ query, ids: new Set() });
  const shownIds = new Set(rows.map((row) => row.id));
  const selected =
    selection.query === query
      ? new Set([...selection.ids].filter((id) => shownIds.has(id)))
      : new Set<string>();
  const select = (ids: ReadonlySet<string>) => {
    setSelection({ query, ids });
  };
  const full = selected.size >= TASK_LIMITS.bulk;

  function complete(task: TaskRow, done: boolean) {
    setTicked((previous) => new Map(previous).set(task.id, done));
    const at = rows.findIndex((row) => row.id === task.id);
    completion.mutate({ task, completed: done, index: at < 0 ? rows.length : at });
  }

  // The Completed section: this visit's settled rows first, then the server's completed page.
  const completedItems: TaskRow[] = [
    ...finished
      .filter((entry) => entry.settled)
      .map((entry) => ({ ...entry.task, completed: true })),
    ...(completed?.tasks ?? []).filter(
      (row) => !finishedById.has(row.id) && !serverIds.has(row.id) && ticked.get(row.id) !== false,
    ),
  ].filter((row) => ticked.get(row.id) !== false);
  const completedCount =
    (completed?.total ?? 0) +
    finished.filter(
      (entry) => entry.settled && !(completed?.tasks ?? []).some((row) => row.id === entry.task.id),
    ).length;

  const panelHref = (id: string) =>
    `${tasksPath(homeId)}?${panelQuery ? `${panelQuery}&` : ""}task=${id}`;

  function renderRow(task: TaskRow, inCompletedSection: boolean) {
    const isDone = ticked.get(task.id) ?? task.completed;
    const retained = !inCompletedSection && isDone && finishedById.has(task.id);
    const isSelected = selectedId === task.id;
    const days = task.overdue && task.dueDate && today ? daysOverdue(task.dueDate, today) : 0;
    const late = days >= SIGNIFICANTLY_OVERDUE_DAYS;
    const bar = task.priority ? priorityBar[task.priority] : undefined;
    return (
      <li
        key={task.id}
        className={cx(
          "relative flex items-start gap-3 border-b border-line py-3 ps-4 pe-2 last:border-b-0",
          "motion-safe:transition-colors motion-safe:duration-(--md-duration-base)",
          // A ring, not a tinted fill: muted text keeps its contrast on the plain surface.
          isSelected || retained ? "ring-1 ring-inset ring-accent-edge" : "",
          inCompletedSection ? "opacity-80" : "",
        )}
        data-testid="task-row"
        data-task-id={task.id}
      >
        {bar ? (
          <span
            aria-hidden="true"
            className={cx("absolute inset-y-2.5 start-0 rounded-full", bar)}
          />
        ) : null}
        {selecting ? (
          <Checkbox
            label={tBulk("selectTask", { task: task.title })}
            className="mt-0.5 [&_label]:sr-only"
            checked={selected.has(task.id)}
            disabled={full && !selected.has(task.id)}
            onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(task.id);
              else next.delete(task.id);
              select(next);
            }}
            data-testid="bulk-checkbox"
          />
        ) : null}
        {task.canComplete ? (
          <Checkbox
            label={t("completeTask", { task: task.title })}
            className="mt-0.5 [&_label]:sr-only"
            checked={isDone}
            onChange={(event) => {
              const done = event.target.checked;
              // Unfinished subtasks: ask first, like the task page (spec).
              if (done && task.subtasksDone < task.subtasksTotal) {
                setConfirming(task);
                return;
              }
              complete(task, done);
            }}
          />
        ) : (
          <span className="mt-0.5 text-helper text-fg-muted">
            {task.completed ? t("statusDone") : t("statusOpen")}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Link
            href={panelHref(task.id)}
            scroll={false}
            aria-current={isSelected ? "true" : undefined}
            className={cx(
              "font-medium underline-offset-2 hover:underline",
              isDone ? "text-fg-muted line-through" : "text-fg",
            )}
          >
            <bdi>{task.title}</bdi>
          </Link>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-helper text-fg-muted">
            {isDone ? <span>{t("statusCompleted")}</span> : null}
            {task.recurring ? (
              <span className="inline-flex items-center gap-1" data-testid="task-repeats">
                <RepeatIcon size="sm" />
                {t("repeatsBadge")}
              </span>
            ) : null}
            {showListName ? (
              <span>
                {t("inList")} <bdi>{task.listName}</bdi>
              </span>
            ) : null}
            {task.dueDate ? (
              task.overdue && !isDone ? (
                <span className="inline-flex items-center gap-1 font-semibold text-danger">
                  {late ? <WarningIcon size="sm" /> : null}
                  {today
                    ? t("overdueDays", {
                        count: days,
                        date: formatTaskDate(task.dueDate, { dateFormat }),
                      })
                    : t("dueOverdue", { date: formatTaskDate(task.dueDate, { dateFormat }) })}
                </span>
              ) : today && task.dueDate === today ? (
                <span>{t("dueToday")}</span>
              ) : (
                <span>{t("dueOn", { date: formatTaskDate(task.dueDate, { dateFormat }) })}</span>
              )
            ) : null}
            {task.startDate && task.upcoming ? (
              <span>{t("startsOn", { date: formatTaskDate(task.startDate, { dateFormat }) })}</span>
            ) : null}
            {task.priority && task.priority !== "normal" ? (
              <span>{t("priorityShown", { priority: texts.priority(task.priority) })}</span>
            ) : null}
            {task.subtasksTotal > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-1 w-10 overflow-hidden rounded-full bg-line"
                >
                  <span
                    className="block h-full bg-accent"
                    style={{
                      width: `${String(Math.round((task.subtasksDone / task.subtasksTotal) * 100))}%`,
                    }}
                  />
                </span>
                {t("subtaskProgress", { done: task.subtasksDone, total: task.subtasksTotal })}
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
        {retained && task.canComplete ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={completion.busy}
            onClick={() => {
              complete(task, false);
            }}
            data-testid="task-undo"
          >
            {t("undo")}
          </Button>
        ) : null}
      </li>
    );
  }

  if (hideWhenEmpty && rows.length === 0 && completedItems.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3" data-testid="task-list">
      <HydrationGate>
        {region}
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-section-title font-semibold text-fg outline-none"
        >
          {heading
            ? t("groupHeading", { title: heading, count: total })
            : t("listCount", { count: total })}
        </h2>
        {selectable && rows.length > 0 && !selecting ? (
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                select(new Set());
                setSelecting(true);
              }}
              data-testid="bulk-select"
            >
              {tBulk("select")}
            </Button>
          </div>
        ) : null}
        {selecting ? (
          <BulkBar
            homeId={homeId}
            shown={rows}
            selected={selected}
            onSelect={select}
            onDone={() => {
              select(new Set());
              setSelecting(false);
            }}
            labels={labels}
            lists={moveLists}
          />
        ) : null}
        {completion.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(completion.error.failure)}
          </FormAlert>
        ) : null}
        {rows.length === 0 && heading && !filtered ? (
          <p className="text-body text-fg-muted">{t("groupEmpty")}</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title={filtered ? t("emptyFilteredTitle") : t("emptyTitle")}
            description={filtered ? t("emptyFiltered") : t("empty")}
          />
        ) : (
          <ul className="flex flex-col">{rows.map((task) => renderRow(task, false))}</ul>
        )}
        {pages.hasNextPage ? (
          <div>
            <Button
              variant="secondary"
              loading={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
              data-testid="tasks-more"
            >
              {t("showMore", { count: Math.min(pageSize, serverTotal - serverRows.length) })}
            </Button>
          </div>
        ) : null}
        {pages.isFetchNextPageError ? (
          <FormAlert tone="error" announce>
            {t("moreFailed")}
          </FormAlert>
        ) : null}
        {creation ? <NewTask {...creation} homeId={homeId} placement="inline" /> : null}
        {completedCount > 0 || completedItems.length > 0 ? (
          <div data-testid="completed-section">
            <button
              type="button"
              aria-expanded={showCompleted}
              aria-controls={`${headingId}-completed`}
              onClick={() => {
                setShowCompleted((value) => !value);
              }}
              className="press-feedback inline-flex min-h-10 items-center gap-1.5 rounded-control px-2 text-body font-medium text-fg-muted hover:bg-accent-subtle hover:text-fg"
            >
              <ChevronDownIcon
                size="sm"
                className={cx(
                  "motion-safe:transition-transform",
                  showCompleted ? "" : "-rotate-90 rtl:rotate-90",
                )}
              />
              {t("completedSection", { count: Math.max(completedCount, completedItems.length) })}
            </button>
            {showCompleted ? (
              <ul id={`${headingId}-completed`} className="mt-1 flex flex-col">
                {completedItems.map((task) => renderRow(task, true))}
              </ul>
            ) : null}
          </div>
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
