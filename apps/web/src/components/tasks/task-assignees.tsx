"use client";

import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";

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
import { memberNames, type MemberOption } from "@/tasks/format";
import { TASK_LIMITS, type SeriesScope } from "@/tasks/schema";

import { HydrationGate } from "./hydration-gate";
import { sendSeriesChange, SeriesScopeDialog, type OccurrenceScope } from "./series-scope";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

export interface TaskAssigneesProps {
  readonly task: TaskDetail;
  /** The Home's current members (only they can be assigned). */
  readonly members: readonly MemberOption[];
  readonly dateFormat: DateFormat;
}

/**
 * A Home task's assignees (S18): shown to everyone who can see the task; changed only by task
 * managers (spec: "the Home task-management permission"), choosing among the Home's current
 * members. A flag says when a departed assignee left the task needing reassignment.
 *
 * S19: on an occurrence of a recurring series, saving asks whether the new assignees are for this
 * occurrence, this and following ones, or the entire series (new occurrences get them too).
 */
export function TaskAssignees({ task, members, dateFormat }: TaskAssigneesProps) {
  const t = useTranslations("Tasks");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useTaskTexts(names);
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<readonly string[]>(task.assignees);
  const editButton = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const [asking, setAsking] = useState(false);
  const finish = () => {
    setAsking(false);
    setEditing(false);
    announce(t("announceAssigned"));
    requestAnimationFrame(() => editButton.current?.focus());
  };
  const mutation = useTaskMutation(
    `task:${task.id}`,
    (memberIds: readonly string[]) =>
      sendTaskRequest<RevisionResponse>("PUT", `${TASKS_ENDPOINT}/${task.id}/assignees`, {
        expectedRevision: task.revision,
        memberIds,
      }),
    finish,
  );
  const series = task.series;
  const seriesBody = {
    expectedTaskRevision: task.revision,
    expectedSeriesRevision: series?.revision ?? 1,
    assigneeIds: [...chosen],
  };
  const seriesMutation = useTaskMutation(
    `task:${task.id}`,
    (scope: SeriesScope) => sendSeriesChange(task.id, scope, seriesBody, false),
    finish,
  );
  const busy = mutation.busy || seriesMutation.busy;

  function save() {
    if (series?.can.assign) {
      setAsking(true);
      return;
    }
    mutation.mutate(chosen);
  }

  function confirm(scope: OccurrenceScope) {
    if (scope === "this") mutation.mutate(chosen);
    else seriesMutation.mutate(scope);
  }

  return (
    <section aria-labelledby="task-assignees-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="task-assignees-heading" className="text-section-title font-semibold text-fg">
          {t("assigneesHeading")}
        </h2>
        {task.needsReassignment ? (
          <p className="font-semibold text-warning">{t("needsReassignmentHelp")}</p>
        ) : null}
        {editing ? (
          <fieldset className="flex flex-col gap-2" disabled={busy}>
            <legend className="text-body font-medium text-fg">{t("fieldAssignees")}</legend>
            <p className="text-helper text-fg-muted">{t("fieldAssigneesHelp")}</p>
            {members.map((member) => (
              <Checkbox
                key={member.id}
                label={texts.member(member.id)}
                checked={chosen.includes(member.id)}
                disabled={
                  !chosen.includes(member.id) && chosen.length >= TASK_LIMITS.assigneesPerTask
                }
                onChange={(event) => {
                  setChosen(
                    event.target.checked
                      ? [...chosen, member.id]
                      : chosen.filter((id) => id !== member.id),
                  );
                }}
              />
            ))}
            <div className="flex flex-wrap gap-2">
              <Button loading={busy} onClick={save} data-testid="task-assignees-save">
                {t("save")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(false);
                  setChosen(task.assignees);
                  mutation.reset();
                  seriesMutation.reset();
                  requestAnimationFrame(() => editButton.current?.focus());
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </fieldset>
        ) : (
          <>
            {task.assignees.length === 0 ? (
              <p className="text-body text-fg-muted">{t("noAssignees")}</p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="task-assignees">
                {task.assignees.map((id) => (
                  <li key={id} className="text-body text-fg">
                    <bdi>{texts.member(id)}</bdi>
                  </li>
                ))}
              </ul>
            )}
            {task.can.assign ? (
              <div>
                <Button
                  ref={editButton}
                  variant="secondary"
                  onClick={() => {
                    setChosen(task.assignees);
                    setEditing(true);
                  }}
                  data-testid="task-assignees-edit"
                >
                  {t("changeAssignees")}
                </Button>
              </div>
            ) : null}
          </>
        )}
        {mutation.error && !asking ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
        {asking && series ? (
          <SeriesScopeDialog
            open
            onClose={() => {
              setAsking(false);
              seriesMutation.reset();
            }}
            task={task}
            title={t("scopeAssignTitle")}
            request={{ kind: "change", body: seriesBody }}
            allowThis={task.can.assign}
            allowSeries
            confirmLabel={t("save")}
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
