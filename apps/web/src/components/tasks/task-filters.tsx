import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import type { MemberOption } from "@/tasks/format";
import { taskPriorities, type TaskQuery } from "@/tasks/schema";

import type { LabelOption } from "./label-picker";

export interface TaskFiltersProps {
  readonly action: string;
  readonly query: TaskQuery;
  readonly labels: readonly LabelOption[];
  /** The Home's members for the assignee filter; empty in the Personal space. */
  readonly members: readonly MemberOption[];
  readonly isHome: boolean;
  /** Whether any filter differs from the defaults, for "Clear filters". */
  readonly filtered: boolean;
}

/**
 * The task view's filters and sorting (S18): status, Upcoming / Active / Overdue, whether to hide
 * tasks that start later, priority (with Unspecified), labels (any of them), assignee, and sort
 * order. A plain GET form: it works without JavaScript, lives in the URL and changes only this
 * person's view.
 */
export async function TaskFilters({
  action,
  query,
  labels,
  members,
  isHome,
  filtered,
}: TaskFiltersProps) {
  const t = await getTranslations("Tasks");
  const priorityKey = {
    low: "priorityLow",
    normal: "priorityNormal",
    high: "priorityHigh",
    urgent: "priorityUrgent",
  } as const;

  return (
    <form
      method="get"
      action={action}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      aria-label={t("filtersLabel")}
      data-testid="task-filters"
    >
      {query.list ? <input type="hidden" name="list" value={query.list} /> : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("filterStatus")}
          name="status"
          defaultValue={query.status}
          options={[
            { value: "open", label: t("statusFilterOpen") },
            { value: "completed", label: t("statusFilterCompleted") },
            { value: "all", label: t("statusFilterAll") },
          ]}
        />
        <SelectField
          label={t("filterWhen")}
          name="when"
          defaultValue={query.when}
          description={t("filterWhenHelp")}
          options={[
            { value: "any", label: t("whenAny") },
            { value: "upcoming", label: t("whenUpcoming") },
            { value: "active", label: t("whenActive") },
            { value: "overdue", label: t("whenOverdue") },
          ]}
        />
        {isHome ? (
          <SelectField
            label={t("filterAssignee")}
            name="assignee"
            defaultValue={
              query.assignee === "member" && query.member ? query.member : query.assignee
            }
            options={[
              { value: "any", label: t("assigneeAny") },
              { value: "me", label: t("assigneeMe") },
              { value: "unassigned", label: t("assigneeUnassigned") },
              { value: "needs_reassignment", label: t("assigneeNeedsReassignment") },
              ...members
                .filter((member) => !member.isSelf)
                .map((member) => ({ value: member.id, label: member.name ?? t("personUnnamed") })),
            ]}
          />
        ) : null}
        <SelectField
          label={t("filterSort")}
          name="sort"
          defaultValue={query.sort}
          options={[
            { value: "due", label: t("sortDue") },
            { value: "priority_desc", label: t("sortPriorityDesc") },
            { value: "priority_asc", label: t("sortPriorityAsc") },
            { value: "created", label: t("sortCreated") },
          ]}
        />
      </div>
      {/* Unchecked boxes send nothing, so the hidden 0 states "show them" explicitly. */}
      <input type="hidden" name="hideFuture" value="0" />
      <Checkbox
        label={t("filterHideFuture")}
        description={t("filterHideFutureHelp")}
        name="hideFuture"
        value="1"
        defaultChecked={query.hideFuture === "1"}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="text-body font-medium text-fg">{t("filterPriority")}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {[...taskPriorities, "unset" as const].map((value) => (
            <Checkbox
              key={value}
              name="priority"
              value={value}
              label={value === "unset" ? t("priorityUnset") : t(priorityKey[value])}
              defaultChecked={query.priority.includes(value)}
            />
          ))}
        </div>
      </fieldset>
      {labels.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body font-medium text-fg">{t("filterLabels")}</legend>
          <p className="text-helper text-fg-muted">{t("filterLabelsHelp")}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {labels.map((label) => (
              <Checkbox
                key={label.id}
                name="label"
                value={label.id}
                label={label.name}
                defaultChecked={query.label.includes(label.id)}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary">
          {t("applyFilters")}
        </Button>
        {filtered ? (
          <Link
            href={query.list ? `${action}?list=${query.list}` : action}
            className="text-body font-medium text-accent-fg underline"
          >
            {t("clearFilters")}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
