"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAnnouncer } from "@/components/ui/use-announcer";
import type { DateFormat } from "@/preferences/schema";
import {
  sendTaskRequest,
  TASKS_ENDPOINT,
  type RevisionResponse,
  type TaskDetail,
} from "@/tasks/api";
import { formatTaskDate, noMembers } from "@/tasks/format";
import { startOffsetOf, type SeriesScope, type UpdateTaskInput } from "@/tasks/schema";

import { LabelChip } from "./label-chip";
import type { LabelOption } from "./label-picker";
import { TaskForm, type TaskFormOutput } from "./task-form";
import { HydrationGate } from "./hydration-gate";
import { noRepeat } from "./repeat-fields";
import {
  sendSeriesChange,
  SeriesScopeDialog,
  type OccurrenceScope,
  type SeriesChangeBody,
} from "./series-scope";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

export interface TaskContentProps {
  readonly task: TaskDetail;
  readonly labels: readonly LabelOption[];
  readonly dateFormat: DateFormat;
  /** S19b: the task has a reminder before its due date (a due-date change puts it on hold). */
  readonly reminderBeforeDue?: boolean;
}

/**
 * A task's content (S18): description, dates, priority and labels, and for people who may edit it
 * an Edit form. A save names the revision it started from; if someone saved in between, nothing is
 * overwritten: the draft stays on screen with the explanation until the person loads the latest
 * version.
 *
 * S19: on an occurrence of a recurring series, a person who may change the series is asked whether
 * the change is for this occurrence, this and following ones, or the entire series, with a preview.
 * A changed due date only applies to this occurrence (the schedule sets the series' dates).
 */
export function TaskContent({
  task,
  labels,
  dateFormat,
  reminderBeforeDue = false,
}: TaskContentProps) {
  const t = useTranslations("Tasks");
  const texts = useTaskTexts(noMembers);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const [pending, setPending] = useState<TaskFormOutput | null>(null);
  const [copySubtasks, setCopySubtasks] = useState(false);
  const finish = () => {
    setPending(null);
    setEditing(false);
    announce(t("announceSaved"));
    requestAnimationFrame(() => editButton.current?.focus());
  };
  const mutation = useTaskMutation(
    `task:${task.id}`,
    (input: UpdateTaskInput) =>
      sendTaskRequest<RevisionResponse>("PATCH", `${TASKS_ENDPOINT}/${task.id}`, input),
    finish,
  );
  const seriesMutation = useTaskMutation(
    `task:${task.id}`,
    ({ scope, body }: { readonly scope: SeriesScope; readonly body: SeriesChangeBody }) =>
      sendSeriesChange(task.id, scope, body, false),
    finish,
  );
  const series = task.series;
  const dueChanged = pending !== null && pending.dueDate !== task.dueDate;
  const seriesAllowed = series !== null && series.can.edit && !dueChanged;

  function seriesBody(values: TaskFormOutput): SeriesChangeBody {
    const dueDate = values.dueDate ?? task.dueDate;
    return {
      expectedTaskRevision: task.revision,
      expectedSeriesRevision: series?.revision ?? 1,
      content: {
        title: values.title,
        description: values.description,
        priority: values.priority,
        labelIds: [...values.labelIds],
        startOffset: dueDate ? startOffsetOf(values.startDate, dueDate) : null,
        copySubtasks,
      },
    };
  }

  function save(values: TaskFormOutput) {
    if (series?.can.edit) {
      setCopySubtasks(false);
      setPending(values);
      return;
    }
    saveThis(values);
  }

  function confirm(scope: OccurrenceScope) {
    if (!pending) return;
    if (scope === "this") {
      saveThis(pending);
      return;
    }
    seriesMutation.mutate({ scope, body: seriesBody(pending) });
  }

  function saveThis(values: TaskFormOutput) {
    mutation.mutate({
      expectedRevision: task.revision,
      title: values.title,
      description: values.description,
      startDate: values.startDate,
      dueDate: values.dueDate,
      priority: values.priority,
      labelIds: [...values.labelIds],
    });
  }

  const date = (value: string) => formatTaskDate(value, { dateFormat });

  return (
    <section aria-labelledby="task-content-heading" className="flex flex-col gap-4">
      <HydrationGate>
        {region}
        <h2 id="task-content-heading" className="text-section-title font-semibold text-fg">
          {t("detailsHeading")}
        </h2>
        {editing ? (
          <>
            {reminderBeforeDue ? (
              <FormAlert tone="info">
                <p data-testid="due-reminder-warning">{t("dueReminderWarning")}</p>
              </FormAlert>
            ) : null}
            <TaskForm
              mode="edit"
              defaults={{
                title: task.title,
                description: task.description ?? "",
                startDate: task.startDate ?? "",
                dueDate: task.dueDate ?? "",
                priority: task.priority ?? "",
                labelIds: task.labels.map((label) => label.id),
                listId: task.list.id,
                assigneeIds: [],
                repeat: noRepeat,
              }}
              labels={labels}
              busy={mutation.busy || seriesMutation.busy}
              onSubmit={save}
              onCancel={() => {
                setEditing(false);
                mutation.reset();
                seriesMutation.reset();
                requestAnimationFrame(() => editButton.current?.focus());
              }}
              submitLabel={t("save")}
              focusTitle
            />
            {pending && series ? (
              <SeriesScopeDialog
                open
                onClose={() => {
                  setPending(null);
                  seriesMutation.reset();
                }}
                task={task}
                title={t("scopeSaveTitle")}
                request={{ kind: "change", body: seriesBody(pending) }}
                allowThis
                allowSeries={seriesAllowed}
                {...(dueChanged ? { note: t("scopeDateNote") } : {})}
                confirmLabel={t("save")}
                busy={mutation.busy || seriesMutation.busy}
                dateFormat={dateFormat}
                onConfirm={confirm}
                error={seriesMutation.error ?? mutation.error}
                seriesOptions={
                  task.subtasks.length > 0 ? (
                    <Checkbox
                      label={t("scopeCopySubtasks", { count: task.subtasks.length })}
                      description={t("scopeCopySubtasksHelp")}
                      checked={copySubtasks}
                      onChange={(event) => {
                        setCopySubtasks(event.target.checked);
                      }}
                    />
                  ) : null
                }
              />
            ) : null}
            {mutation.error && !pending ? (
              <FormAlert tone="error" announce>
                <p>{texts.failure(mutation.error.failure)}</p>
                {mutation.error.failure === "conflict" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      // The latest version from the server; the person chose to leave the draft.
                      window.location.reload();
                    }}
                  >
                    {t("loadLatest")}
                  </Button>
                ) : null}
              </FormAlert>
            ) : null}
          </>
        ) : (
          <>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
              <dt className="text-body font-medium text-fg">{t("fieldDescription")}</dt>
              <dd className="whitespace-pre-wrap text-body text-fg">
                {task.description ?? <span className="text-fg-muted">{t("noDescription")}</span>}
              </dd>
              <dt className="text-body font-medium text-fg">{t("fieldStartDate")}</dt>
              <dd className="text-body text-fg">
                {task.startDate ? (
                  date(task.startDate)
                ) : (
                  <span className="text-fg-muted">{t("noDate")}</span>
                )}
                {task.upcoming ? (
                  <span className="ms-2 text-fg-muted">{t("upcomingBadge")}</span>
                ) : null}
              </dd>
              <dt className="text-body font-medium text-fg">{t("fieldDueDate")}</dt>
              <dd className="text-body text-fg">
                {task.dueDate ? (
                  date(task.dueDate)
                ) : (
                  <span className="text-fg-muted">{t("noDate")}</span>
                )}
                {task.overdue ? (
                  <span className="ms-2 font-semibold text-danger">{t("overdueBadge")}</span>
                ) : null}
              </dd>
              <dt className="text-body font-medium text-fg">{t("fieldPriority")}</dt>
              <dd className="text-body text-fg">{texts.priority(task.priority)}</dd>
              <dt className="text-body font-medium text-fg">{t("fieldLabels")}</dt>
              <dd>
                {task.labels.length === 0 ? (
                  <span className="text-body text-fg-muted">{t("labelsChosenNone")}</span>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {task.labels.map((label) => (
                      <li key={label.id}>
                        <LabelChip name={label.name} color={label.color} />
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
            {task.can.edit ? (
              <div>
                <Button
                  ref={editButton}
                  variant="secondary"
                  onClick={() => {
                    setEditing(true);
                  }}
                  data-testid="task-edit"
                >
                  {t("edit")}
                </Button>
              </div>
            ) : (
              <p className="text-helper text-fg-muted">{t("readOnlyNotice")}</p>
            )}
          </>
        )}
      </HydrationGate>
    </section>
  );
}
