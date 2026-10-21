"use client";

import { RepeatIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { isolate } from "@/invitations/format";
import type { DateFormat } from "@/preferences/schema";
import {
  sendTaskRequest,
  TASKS_ENDPOINT,
  type CompletionResponse,
  type TaskRow,
} from "@/tasks/api";
import { formatTaskDate, memberNames, tasksPath, type MemberOption } from "@/tasks/format";

import { LabelChip } from "./label-chip";
import type { LabelOption } from "./label-picker";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

export interface CompactTaskListProps {
  readonly homeId: string | null;
  readonly rows: readonly TaskRow[];
  readonly labels: readonly LabelOption[];
  readonly members: readonly MemberOption[];
  readonly dateFormat: DateFormat;
  /** All Tasks or a calendar day: name each task's list. */
  readonly showListName: boolean;
  /** Serializes this list's completions (one per widget or calendar). */
  readonly scope: string;
  /** When the server rendered these rows: a refresh starts from the server's state again. */
  readonly loadedAt: string;
  readonly testId?: string;
}

/**
 * A short list of tasks with their essentials and the shared completion checkbox (S19c), for task
 * widgets and a calendar day. The same rules as the full list: the box only when the database says
 * the viewer may complete it, a confirmation for unfinished subtasks, one shared completion (an
 * already completed answer names who did it), per-occurrence completion for recurring tasks. The
 * page refreshes afterwards, so every view shows the database's state.
 */
export function CompactTaskList({
  homeId,
  rows,
  labels,
  members,
  dateFormat,
  showListName,
  scope,
  loadedAt,
  testId,
}: CompactTaskListProps) {
  const t = useTranslations("Tasks");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useTaskTexts(names);
  const labelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels]);
  const [confirming, setConfirming] = useState<TaskRow | null>(null);
  // What the person just ticked, shown until the refreshed rows confirm it (kept per server render).
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
  const { announce, region } = useAnnouncer();

  const completion = useTaskMutation(
    `compact-completion:${scope}`,
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
    <div className="flex flex-col gap-2">
      {region}
      {completion.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(completion.error.failure)}
        </FormAlert>
      ) : null}
      <ul className="flex flex-col gap-2" data-testid={testId}>
        {rows.map((task) => (
          <li key={task.id} className="flex items-start gap-3" data-testid="compact-task">
            {task.canComplete ? (
              <Checkbox
                label={t("completeTask", { task: task.title })}
                className="mt-0.5 [&_label]:sr-only"
                checked={ticked.get(task.id) ?? task.completed}
                disabled={completion.busy}
                onChange={(event) => {
                  const completed = event.target.checked;
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
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Link
                href={`${tasksPath(homeId)}/${task.id}`}
                className={`font-medium text-fg underline-offset-2 hover:underline ${task.completed ? "line-through" : ""}`}
              >
                <bdi>{task.title}</bdi>
              </Link>
              <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-helper text-fg-muted">
                {task.completed ? <span>{t("statusCompleted")}</span> : null}
                {task.recurring ? (
                  <span className="inline-flex items-center gap-1">
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
                    {t("subtaskProgress", { done: task.subtasksDone, total: task.subtasksTotal })}
                  </span>
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
      <Dialog
        open={confirming !== null}
        onClose={() => {
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
              data-testid="compact-confirm-complete"
            >
              {t("markComplete")}
            </Button>
          </>
        }
      />
    </div>
  );
}
