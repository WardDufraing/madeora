"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import {
  taskWidgetCounts,
  taskWidgetPriorities,
  taskWidgetStatuses,
  taskWidgetWhens,
  type WidgetConfigs,
} from "@/dashboard/widgets";
import { sendTaskRequest, TASKS_ENDPOINT, type TaskRequestError } from "@/tasks/api";
import type { TaskWidgetOptions } from "@/tasks/widget-data";

/**
 * Typed query key of a context's task lists, labels and members for the widget settings. The whole
 * cache is cleared on sign-out and identity changes (AuthSync), so one person's options never reach
 * the next.
 */
export const taskOptionsKey = (homeId: string | null) =>
  ["tasks", "options", homeId ?? "personal"] as const;

/**
 * A tasks widget's settings (S19c): the list (or All Tasks), status, timing, priorities, labels,
 * and in a Home the assignee, and how many tasks to show. The choices are this context's own lists,
 * labels and members, read only in edit mode; the server checks every id again on save and render.
 */
export function TaskWidgetSettings({
  config,
  homeId,
  onChange,
}: {
  readonly config: WidgetConfigs["tasks"];
  readonly homeId: string | null;
  readonly onChange: (config: WidgetConfigs["tasks"]) => void;
}) {
  const t = useTranslations("TaskWidgets");
  const tasks = useTranslations("Tasks");
  const options = useQuery<TaskWidgetOptions, TaskRequestError>({
    queryKey: taskOptionsKey(homeId),
    queryFn: () =>
      sendTaskRequest<TaskWidgetOptions>(
        "GET",
        homeId
          ? `${TASKS_ENDPOINT}/options?homeId=${encodeURIComponent(homeId)}`
          : `${TASKS_ENDPOINT}/options`,
      ),
    retry: false,
  });
  const set = <K extends keyof WidgetConfigs["tasks"]>(
    key: K,
    value: WidgetConfigs["tasks"][K],
  ) => {
    onChange({ ...config, [key]: value });
  };
  const toggle = <V extends string>(values: readonly V[], value: V, on: boolean): V[] =>
    on ? [...values.filter((v) => v !== value), value] : values.filter((v) => v !== value);

  const statusKey = {
    open: "statusFilterOpen",
    completed: "statusFilterCompleted",
    all: "statusFilterAll",
  } as const;
  const whenKey = {
    any: "whenAny",
    overdue: "whenOverdue",
    due_today: "whenDueToday",
    due_week: "whenDueWeek",
    upcoming: "whenUpcoming",
    undated: "whenUndated",
  } as const;
  const priorityKey = {
    low: "priorityLow",
    normal: "priorityNormal",
    high: "priorityHigh",
    urgent: "priorityUrgent",
    unset: "priorityUnset",
  } as const;

  if (options.isPending) {
    return <p className="text-helper text-fg-muted">{t("settingsLoading")}</p>;
  }
  if (options.error) {
    return (
      <FormAlert tone="error" announce>
        {t("settingsFailed")}
      </FormAlert>
    );
  }
  const { lists, labels, members } = options.data;
  const activeLists = lists.filter((list) => !list.archived);
  const listMissing =
    config.listId !== null && !activeLists.some((list) => list.id === config.listId);
  const knownLabels = new Set(labels.map((label) => label.id));
  const others = members.filter((member) => !member.isSelf);
  const memberMissing =
    config.assignee === "member" &&
    (config.memberId === null || !others.some((member) => member.id === config.memberId));

  return (
    <div className="flex flex-col gap-4" data-testid="task-widget-settings">
      <SelectField
        label={t("settingList")}
        value={listMissing ? "missing" : (config.listId ?? "")}
        options={[
          { value: "", label: t("settingListAll") },
          ...(listMissing ? [{ value: "missing", label: t("settingListMissing") }] : []),
          ...activeLists.map((list) => ({ value: list.id, label: list.name })),
        ]}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value !== "missing") set("listId", value === "" ? null : value);
        }}
      />
      <SelectField
        label={tasks("filterStatus")}
        value={config.status}
        options={taskWidgetStatuses.map((value) => ({
          value,
          label: tasks(statusKey[value]),
        }))}
        onChange={(event) => {
          const value = taskWidgetStatuses.find((v) => v === event.currentTarget.value);
          if (value) set("status", value);
        }}
      />
      <SelectField
        label={tasks("filterWhen")}
        value={config.when}
        options={taskWidgetWhens.map((value) => ({ value, label: tasks(whenKey[value]) }))}
        onChange={(event) => {
          const value = taskWidgetWhens.find((v) => v === event.currentTarget.value);
          if (value) set("when", value);
        }}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="text-body font-medium text-fg">{tasks("filterPriority")}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {taskWidgetPriorities.map((value) => (
            <Checkbox
              key={value}
              label={tasks(priorityKey[value])}
              checked={config.priorities.includes(value)}
              onChange={(event) => {
                set("priorities", toggle(config.priorities, value, event.currentTarget.checked));
              }}
            />
          ))}
        </div>
      </fieldset>
      {labels.length > 0 || config.labelIds.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body font-medium text-fg">{tasks("filterLabels")}</legend>
          <p className="text-helper text-fg-muted">{tasks("filterLabelsHelp")}</p>
          {config.labelIds.some((id) => !knownLabels.has(id)) ? (
            <p className="text-helper text-warning">{t("settingLabelsMissing")}</p>
          ) : null}
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {labels.map((label) => (
              <Checkbox
                key={label.id}
                label={label.name}
                checked={config.labelIds.includes(label.id)}
                onChange={(event) => {
                  set(
                    "labelIds",
                    toggle(
                      config.labelIds.filter((id) => knownLabels.has(id)),
                      label.id,
                      event.currentTarget.checked,
                    ),
                  );
                }}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
      {homeId ? (
        <SelectField
          label={tasks("filterAssignee")}
          value={
            config.assignee === "member"
              ? memberMissing
                ? "missing"
                : (config.memberId ?? "missing")
              : config.assignee
          }
          options={[
            { value: "any", label: tasks("assigneeAny") },
            { value: "me", label: tasks("assigneeMe") },
            { value: "unassigned", label: tasks("assigneeUnassigned") },
            ...(memberMissing ? [{ value: "missing", label: t("settingMemberMissing") }] : []),
            ...others.map((member) => ({
              value: member.id,
              label: member.name ?? tasks("personUnnamed"),
            })),
          ]}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "missing") return;
            if (value === "any" || value === "me" || value === "unassigned") {
              onChange({ ...config, assignee: value, memberId: null });
            } else {
              onChange({ ...config, assignee: "member", memberId: value });
            }
          }}
        />
      ) : null}
      <SelectField
        label={t("settingCount")}
        value={String(config.count)}
        options={taskWidgetCounts.map((count) => ({
          value: String(count),
          label: t("settingCountOption", { count }),
        }))}
        onChange={(event) => {
          const count = taskWidgetCounts.find((c) => String(c) === event.currentTarget.value);
          if (count) set("count", count);
        }}
      />
    </div>
  );
}
