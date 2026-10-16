"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { MemberOption } from "@/tasks/format";
import {
  dateOnlySchema,
  descriptionSchema,
  TASK_LIMITS,
  taskPriorities,
  taskTitleSchema,
  type TaskFieldError,
  type TaskPriority,
} from "@/tasks/schema";

import { LabelPicker, type LabelOption } from "./label-picker";

const optionalDate = z.union([z.literal(""), dateOnlySchema]).transform((value) => value || null);

const formSchema = z
  .object({
    title: taskTitleSchema,
    description: descriptionSchema,
    startDate: optionalDate,
    dueDate: optionalDate,
    priority: z.union([z.literal(""), z.enum(taskPriorities)]).transform((value) => value || null),
    labelIds: z.array(z.string()).max(TASK_LIMITS.labelsPerTask),
    listId: z.string(),
    assigneeIds: z.array(z.string()).max(TASK_LIMITS.assigneesPerTask),
  })
  .refine(
    (task) => task.startDate === null || task.dueDate === null || task.startDate <= task.dueDate,
    { message: "dateOrder" satisfies TaskFieldError, path: ["dueDate"] },
  );
export type TaskFormInput = z.input<typeof formSchema>;
export type TaskFormOutput = z.output<typeof formSchema>;

export interface TaskFormProps {
  readonly mode: "create" | "edit";
  readonly defaults: TaskFormInput;
  readonly labels: readonly LabelOption[];
  /** Lists to choose from when creating (the active lists of this context). */
  readonly lists?: readonly { readonly id: string; readonly name: string }[];
  /** Members to assign when creating, only for task managers in a Home. */
  readonly members?: readonly MemberOption[];
  readonly busy: boolean;
  readonly onSubmit: (values: TaskFormOutput) => void;
  readonly onCancel?: () => void;
  readonly submitLabel: string;
  /** Moves focus to the title when the form appears (opening it, or after adding a task). */
  readonly focusTitle?: boolean;
}

const fieldErrorKey = {
  required: "fieldRequired",
  tooLong: "fieldTooLong",
  invalidCharacters: "fieldInvalidCharacters",
  dateOrder: "fieldDateOrder",
  invalid: "fieldInvalid",
} as const satisfies Record<TaskFieldError, string>;

/**
 * A task's fields (S18): title, plain-text description, optional start and due dates (calendar dates
 * in the context's timezone, either can be cleared), optional priority (unset is distinct from
 * Normal), labels, and when creating the list and, for task managers in a Home, the assignees. The
 * server validates everything again.
 */
export function TaskForm({
  mode,
  defaults,
  labels,
  lists = [],
  members = [],
  busy,
  onSubmit,
  onCancel,
  submitLabel,
  focusTitle = false,
}: TaskFormProps) {
  const t = useTranslations("Tasks");
  const hydrated = useHydrated();
  const form = useForm<TaskFormInput, unknown, TaskFormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults,
  });
  const errors = form.formState.errors;
  useEffect(() => {
    if (focusTitle) form.setFocus("title");
  }, [focusTitle, form]);
  const message = (error: { readonly message?: string | undefined } | undefined) => {
    const key = error?.message as TaskFieldError | undefined;
    return key && key in fieldErrorKey ? t(fieldErrorKey[key]) : undefined;
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit(onSubmit)(event);
      }}
      className="flex flex-col gap-4"
      data-testid={mode === "create" ? "new-task-form" : "task-edit-form"}
    >
      <TextField
        label={t("fieldTitle")}
        required
        autoComplete="off"
        maxLength={TASK_LIMITS.title * 2}
        error={message(errors.title)}
        {...form.register("title")}
      />
      {mode === "create" && lists.length > 0 ? (
        <SelectField
          label={t("fieldList")}
          description={t("fieldListHelp")}
          options={lists.map((list) => ({ value: list.id, label: list.name }))}
          {...form.register("listId")}
        />
      ) : null}
      <TextArea
        label={t("fieldDescription")}
        rows={3}
        error={message(errors.description)}
        {...form.register("description")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          type="date"
          label={t("fieldStartDate")}
          description={t("fieldStartDateHelp")}
          error={message(errors.startDate)}
          {...form.register("startDate")}
        />
        <TextField
          type="date"
          label={t("fieldDueDate")}
          description={t("fieldDueDateHelp")}
          error={message(errors.dueDate)}
          {...form.register("dueDate")}
        />
      </div>
      <SelectField
        label={t("fieldPriority")}
        options={[
          { value: "", label: t("priorityUnset") },
          ...taskPriorities.map((priority: TaskPriority) => ({
            value: priority,
            label: t(
              (
                {
                  low: "priorityLow",
                  normal: "priorityNormal",
                  high: "priorityHigh",
                  urgent: "priorityUrgent",
                } as const
              )[priority],
            ),
          })),
        ]}
        {...form.register("priority")}
      />
      <Controller
        control={form.control}
        name="labelIds"
        render={({ field }) => (
          <LabelPicker labels={labels} value={field.value} onChange={field.onChange} />
        )}
      />
      {mode === "create" && members.length > 0 ? (
        <Controller
          control={form.control}
          name="assigneeIds"
          render={({ field }) => (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-body font-medium text-fg">{t("fieldAssignees")}</legend>
              <p className="text-helper text-fg-muted">{t("fieldAssigneesHelp")}</p>
              {members.map((member) => (
                <Checkbox
                  key={member.id}
                  label={member.isSelf ? t("personYou") : (member.name ?? t("personUnnamed"))}
                  checked={field.value.includes(member.id)}
                  onChange={(event) => {
                    field.onChange(
                      event.target.checked
                        ? [...field.value, member.id]
                        : field.value.filter((id) => id !== member.id),
                    );
                  }}
                />
              ))}
            </fieldset>
          )}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!hydrated} loading={busy}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
