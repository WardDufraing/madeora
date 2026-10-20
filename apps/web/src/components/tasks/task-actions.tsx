"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import type { DateFormat } from "@/preferences/schema";
import {
  sendTaskRequest,
  TASKS_ENDPOINT,
  type CompletionResponse,
  type RevisionResponse,
  type TaskDetail,
} from "@/tasks/api";
import { memberNames, tasksPath, type MemberOption } from "@/tasks/format";
import type { SeriesScope } from "@/tasks/schema";

import { HydrationGate } from "./hydration-gate";
import {
  sendSeriesChange,
  sendSeriesDelete,
  SeriesScopeDialog,
  type OccurrenceScope,
} from "./series-scope";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

export interface TaskCompletionProps {
  readonly task: TaskDetail;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
}

/**
 * The task's one shared completion state (S18): who completed it and when, never "everyone".
 * Completing with unfinished subtasks asks first (spec); completing every subtask never completes
 * the task by itself. When someone else was first, the page says who.
 */
export function TaskCompletion({ task, members, formats }: TaskCompletionProps) {
  const t = useTranslations("Tasks");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useTaskTexts(names);
  const [confirming, setConfirming] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const { announce, region } = useAnnouncer();
  const mutation = useTaskMutation(
    `task:${task.id}:completion`,
    (completed: boolean) =>
      sendTaskRequest<CompletionResponse>("PUT", `${TASKS_ENDPOINT}/${task.id}/completion`, {
        completed,
      }),
    (result) => {
      if (result.outcome === "already_completed" && result.completedBy && !result.completedBy.me) {
        announce(t("alreadyCompletedBy", { person: texts.person(result.completedBy) }));
      } else {
        announce(
          result.outcome === "reopened" || result.outcome === "already_open"
            ? t("announceTaskReopened")
            : t("announceTaskCompleted"),
        );
      }
      // The button's label changes: keep the keyboard on the status it describes (S17 M3).
      statusRef.current?.focus();
    },
  );
  const open = task.subtasks.filter((subtask) => !subtask.completed).length;
  const completed = task.completedAt !== null;

  function complete() {
    if (!completed && open > 0) {
      setConfirming(true);
      return;
    }
    mutation.mutate(!completed);
  }

  return (
    <section aria-labelledby="task-status-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="task-status-heading" className="text-section-title font-semibold text-fg">
          {t("statusHeading")}
        </h2>
        <p
          ref={statusRef}
          tabIndex={-1}
          className="text-body text-fg outline-none"
          data-testid="task-status"
        >
          {completed && task.completedAt
            ? t("completedByOn", {
                person: task.completedBy ? texts.person(task.completedBy) : t("personFormer"),
                date: formatDateTime(task.completedAt, formats),
              })
            : task.reopenedAt
              ? t("reopenedByOn", {
                  person: task.reopenedBy ? texts.person(task.reopenedBy) : t("personFormer"),
                  date: formatDateTime(task.reopenedAt, formats),
                })
              : t("notCompleted")}
        </p>
        {task.can.complete ? (
          <div>
            <Button
              variant={completed ? "secondary" : "primary"}
              loading={mutation.busy}
              onClick={complete}
              data-testid="task-complete"
            >
              {completed ? t("reopen") : t("markComplete")}
            </Button>
          </div>
        ) : (
          <p className="text-helper text-fg-muted">{t("cannotComplete")}</p>
        )}
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
        <Dialog
          open={confirming}
          onClose={() => {
            setConfirming(false);
          }}
          title={t("confirmCompleteTitle")}
          description={t("confirmCompleteBody", { count: open })}
          closeLabel={t("close")}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={() => {
                  setConfirming(false);
                  mutation.mutate(true);
                }}
                data-testid="task-confirm-complete"
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

export interface TaskMoveProps {
  readonly task: TaskDetail;
  readonly lists: readonly { readonly id: string; readonly name: string }[];
  readonly dateFormat: DateFormat;
}

/**
 * Moving the task to another active list of the same context, with an explicit destination. On an
 * occurrence of a recurring series (S19), a person who may change the series chooses this
 * occurrence, this and following ones, or the entire series, with a preview; the series scopes
 * also move the schedule, so new occurrences are created in the new list.
 */
export function TaskMove({ task, lists, dateFormat }: TaskMoveProps) {
  const t = useTranslations("Tasks");
  const texts = useTaskTexts(memberNames([]));
  const others = lists.filter((list) => list.id !== task.list.id);
  const [listId, setListId] = useState(others[0]?.id ?? "");
  const [asking, setAsking] = useState(false);
  const { announce, region } = useAnnouncer();
  const finish = () => {
    setAsking(false);
    announce(t("announceMoved"));
  };
  const mutation = useTaskMutation(
    `task:${task.id}`,
    (destination: string) =>
      sendTaskRequest<RevisionResponse>("PUT", `${TASKS_ENDPOINT}/${task.id}/list`, {
        expectedRevision: task.revision,
        listId: destination,
      }),
    finish,
  );
  const series = task.series;
  const seriesBody = {
    expectedTaskRevision: task.revision,
    expectedSeriesRevision: series?.revision ?? 1,
    listId,
  };
  const seriesMutation = useTaskMutation(
    `task:${task.id}`,
    (scope: SeriesScope) => sendSeriesChange(task.id, scope, seriesBody, false),
    finish,
  );
  const seriesAllowed = series?.can.edit ?? false;
  if ((!task.can.edit && !seriesAllowed) || others.length === 0) return null;
  const busy = mutation.busy || seriesMutation.busy;

  function move() {
    if (seriesAllowed) {
      setAsking(true);
      return;
    }
    mutation.mutate(listId);
  }

  function confirm(scope: OccurrenceScope) {
    if (scope === "this") {
      setAsking(false);
      mutation.mutate(listId);
    } else {
      seriesMutation.mutate(scope);
    }
  }

  return (
    <section aria-labelledby="task-move-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="task-move-heading" className="text-section-title font-semibold text-fg">
          {t("moveHeading")}
        </h2>
        <p className="text-helper text-fg-muted">{t("moveHelp")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <SelectField
            label={t("moveDestination")}
            value={listId}
            onChange={(event) => {
              setListId(event.target.value);
            }}
            options={others.map((list) => ({ value: list.id, label: list.name }))}
          />
          <Button
            variant="secondary"
            loading={busy}
            disabled={listId === ""}
            onClick={move}
            data-testid="task-move"
          >
            {t("move")}
          </Button>
        </div>
        {mutation.error && !asking ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
        {asking ? (
          <SeriesScopeDialog
            open
            onClose={() => {
              setAsking(false);
              seriesMutation.reset();
            }}
            task={task}
            title={t("scopeMoveTitle")}
            request={{ kind: "change", body: seriesBody }}
            allowThis={task.can.edit}
            allowSeries
            confirmLabel={t("move")}
            busy={busy}
            dateFormat={dateFormat}
            onConfirm={confirm}
            error={seriesMutation.error ?? mutation.error}
          />
        ) : null}
      </HydrationGate>
    </section>
  );
}

/**
 * Moving the task to the trash, after confirmation; the page then shows the task's context. On an
 * occurrence of a recurring series (S19), a person who may change the series chooses this
 * occurrence, this and following ones, or the entire series, with a preview; the series scopes go
 * to the trash as one item and completed occurrences stay in the history.
 */
export function TaskDelete({
  task,
  dateFormat,
}: {
  readonly task: TaskDetail;
  readonly dateFormat: DateFormat;
}) {
  const t = useTranslations("Tasks");
  const texts = useTaskTexts(memberNames([]));
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const leave = () => {
    // The task is gone from here: go to its list, where a notice (focused by the page) says so.
    router.push(`${tasksPath(task.homeId)}?list=${task.list.id}&deleted=1`);
  };
  const mutation = useTaskMutation(
    `task:${task.id}`,
    () => sendTaskRequest<object>("DELETE", `${TASKS_ENDPOINT}/${task.id}`, {}),
    leave,
  );
  const seriesMutation = useTaskMutation(
    `task:${task.id}`,
    (scope: SeriesScope) => sendSeriesDelete(task, scope, false),
    leave,
  );
  const seriesAllowed = task.series?.can.delete ?? false;
  if (!task.can.delete && !seriesAllowed) return null;
  const busy = mutation.busy || seriesMutation.busy;

  function confirm(scope: OccurrenceScope) {
    if (scope === "this") {
      setConfirming(false);
      mutation.mutate(undefined);
    } else {
      seriesMutation.mutate(scope);
    }
  }

  return (
    <section aria-labelledby="task-delete-heading" className="flex flex-col gap-3">
      <HydrationGate>
        <h2 id="task-delete-heading" className="text-section-title font-semibold text-fg">
          {t("deleteHeading")}
        </h2>
        <p className="text-helper text-fg-muted">
          {task.series ? t("deleteSeriesHelp") : t("deleteHelp")}
        </p>
        <div>
          <Button
            variant="destructive"
            loading={busy}
            onClick={() => {
              setConfirming(true);
            }}
            data-testid="task-delete"
          >
            {t("deleteTask")}
          </Button>
        </div>
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
        {task.series && seriesAllowed ? (
          confirming ? (
            <SeriesScopeDialog
              open
              onClose={() => {
                setConfirming(false);
                seriesMutation.reset();
              }}
              task={task}
              title={t("scopeDeleteTitle")}
              request={{ kind: "delete" }}
              allowThis={task.can.delete}
              allowSeries
              confirmLabel={t("deleteTask")}
              destructive
              busy={busy}
              dateFormat={dateFormat}
              onConfirm={confirm}
              error={seriesMutation.error}
            />
          ) : null
        ) : (
          <Dialog
            open={confirming}
            onClose={() => {
              setConfirming(false);
            }}
            title={t("confirmDeleteTitle")}
            description={t("confirmDeleteBody")}
            closeLabel={t("close")}
            footer={
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirming(false);
                    mutation.mutate(undefined);
                  }}
                  data-testid="task-confirm-delete"
                >
                  {t("deleteTask")}
                </Button>
              </>
            }
          />
        )}
      </HydrationGate>
    </section>
  );
}
