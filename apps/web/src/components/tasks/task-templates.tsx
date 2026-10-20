"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  sendTaskRequest,
  TASK_TEMPLATES_ENDPOINT,
  TaskRequestError,
  type RevisionResponse,
  type TaskDetail,
  type TaskTemplate,
  type TaskTemplateSummary,
} from "@/tasks/api";
import { noMembers } from "@/tasks/format";
import {
  dateOnlySchema,
  descriptionSchema,
  TASK_LIMITS,
  taskPriorities,
  taskTitleSchema,
  templateNameSchema,
  type CreateFromTemplateInput,
  type CreateTemplateInput,
  type TaskFieldError,
  type TaskPriority,
  type UpdateTemplateInput,
} from "@/tasks/schema";

import { HydrationGate } from "./hydration-gate";
import { LabelPicker, type LabelOption } from "./label-picker";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

type FormError = TaskFieldError | "checklistTooMany" | "checklistItem";

const fieldErrorKey = {
  required: "fieldRequired",
  tooLong: "fieldTooLong",
  invalidCharacters: "fieldInvalidCharacters",
  dateOrder: "fieldDateOrder",
  invalid: "fieldInvalid",
} as const satisfies Record<TaskFieldError, string>;

/** A checklist typed one item per line; empty lines are ignored. */
const checklistSchema = z.string().transform((value, context) => {
  const lines = value.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length > TASK_LIMITS.subtasks) {
    context.addIssue({ code: "custom", message: "checklistTooMany" satisfies FormError });
    return z.NEVER;
  }
  const items: string[] = [];
  for (const line of lines) {
    const item = taskTitleSchema.safeParse(line);
    if (!item.success) {
      context.addIssue({ code: "custom", message: "checklistItem" satisfies FormError });
      return z.NEVER;
    }
    items.push(item.data);
  }
  return items;
});

const prioritySchema = z
  .union([z.literal(""), z.enum(taskPriorities)])
  .transform((value) => value || null);

const templateFormSchema = z.object({
  name: templateNameSchema,
  title: taskTitleSchema,
  description: descriptionSchema,
  priority: prioritySchema,
  labelIds: z.array(z.string()).max(TASK_LIMITS.labelsPerTask),
  checklist: checklistSchema,
});
type TemplateFormInput = z.input<typeof templateFormSchema>;
export type TemplateFormOutput = z.output<typeof templateFormSchema>;

const optionalDate = z.union([z.literal(""), dateOnlySchema]).transform((value) => value || null);

const fromTemplateSchema = z
  .object({
    title: taskTitleSchema,
    description: descriptionSchema,
    priority: prioritySchema,
    labelIds: z.array(z.string()).max(TASK_LIMITS.labelsPerTask),
    checklist: checklistSchema,
    listId: z.string().min(1),
    startDate: optionalDate,
    dueDate: optionalDate,
  })
  .refine(
    (task) => task.startDate === null || task.dueDate === null || task.startDate <= task.dueDate,
    { message: "dateOrder" satisfies TaskFieldError, path: ["dueDate"] },
  );
type FromTemplateInput = z.input<typeof fromTemplateSchema>;
type FromTemplateOutput = z.output<typeof fromTemplateSchema>;

function useFieldMessage() {
  const t = useTranslations("Tasks");
  const tTemplates = useTranslations("TaskTemplates");
  return (error: { readonly message?: string | undefined } | undefined) => {
    const key = error?.message;
    if (key === "checklistTooMany") {
      return tTemplates("checklistTooMany", { max: TASK_LIMITS.subtasks });
    }
    if (key === "checklistItem") return tTemplates("checklistItem");
    return key && key in fieldErrorKey ? t(fieldErrorKey[key as TaskFieldError]) : undefined;
  };
}

function usePriorityOptions() {
  const t = useTranslations("Tasks");
  const texts = useTaskTexts(noMembers);
  return [
    { value: "", label: t("priorityUnset") },
    ...taskPriorities.map((priority: TaskPriority) => ({
      value: priority,
      label: texts.priority(priority),
    })),
  ];
}

export interface TemplateFormProps {
  readonly defaults: TemplateFormInput;
  readonly labels: readonly LabelOption[];
  readonly busy: boolean;
  readonly submitLabel: string;
  readonly onSubmit: (values: TemplateFormOutput) => void;
  readonly onCancel: () => void;
  /** Labels the template named that no longer exist and were left out. */
  readonly omittedLabels?: number;
}

/**
 * A template's fields (S19b): its name in the library, and what a task made from it starts with
 * (title, description, priority, labels and checklist). Never dates, people, comments, completion,
 * reminders or a repeat schedule.
 */
export function TemplateForm({
  defaults,
  labels,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
  omittedLabels = 0,
}: TemplateFormProps) {
  const t = useTranslations("TaskTemplates");
  const tTasks = useTranslations("Tasks");
  const message = useFieldMessage();
  const priorities = usePriorityOptions();
  const form = useForm<TemplateFormInput, unknown, TemplateFormOutput>({
    resolver: zodResolver(templateFormSchema),
    defaultValues: defaults,
  });
  const errors = form.formState.errors;
  useEffect(() => {
    form.setFocus("name");
  }, [form]);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit(onSubmit)(event);
      }}
      className="flex flex-col gap-4"
      data-testid="template-form"
    >
      <TextField
        label={t("fieldName")}
        description={t("fieldNameHelp")}
        required
        autoComplete="off"
        error={message(errors.name)}
        {...form.register("name")}
      />
      <TextField
        label={tTasks("fieldTitle")}
        required
        autoComplete="off"
        error={message(errors.title)}
        {...form.register("title")}
      />
      <TextArea
        label={tTasks("fieldDescription")}
        rows={3}
        error={message(errors.description)}
        {...form.register("description")}
      />
      <SelectField
        label={tTasks("fieldPriority")}
        options={priorities}
        {...form.register("priority")}
      />
      {omittedLabels > 0 ? (
        <p className="text-helper text-fg">{t("omittedLabels", { count: omittedLabels })}</p>
      ) : null}
      <Controller
        control={form.control}
        name="labelIds"
        render={({ field }) => (
          <LabelPicker labels={labels} value={field.value} onChange={field.onChange} />
        )}
      />
      <TextArea
        label={t("fieldChecklist")}
        description={t("fieldChecklistHelp", { max: TASK_LIMITS.subtasks })}
        rows={4}
        error={message(errors.checklist)}
        {...form.register("checklist")}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy}>
          {submitLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {tTasks("cancel")}
        </Button>
      </div>
    </form>
  );
}

function Failure({ error }: { readonly error: TaskRequestError | null }) {
  const t = useTranslations("Tasks");
  const texts = useTaskTexts(noMembers);
  if (!error) return null;
  return (
    <FormAlert tone="error" announce>
      <p>{texts.failure(error.failure, error.detail)}</p>
      {error.failure === "conflict" ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => {
            window.location.reload();
          }}
        >
          {t("loadLatest")}
        </Button>
      ) : null}
    </FormAlert>
  );
}

function templateUrl(id: string): string {
  return `${TASK_TEMPLATES_ENDPOINT}/${id}`;
}

function fetchTemplate(id: string): Promise<TaskTemplate> {
  return sendTaskRequest<TaskTemplate>("GET", templateUrl(id));
}

const templateKey = (id: string) => ["task-template", id] as const;

export interface TemplateLibraryProps {
  readonly homeId: string | null;
  readonly templates: readonly TaskTemplateSummary[];
  readonly labels: readonly LabelOption[];
  readonly canManage: boolean;
}

/**
 * The context's templates (S19b), by name. Task managers create, edit and delete them; everyone in
 * the context uses them from New task. Deleting removes the template only, never tasks made from
 * it, and asks first.
 */
export function TemplateLibrary({ homeId, templates, labels, canManage }: TemplateLibraryProps) {
  const t = useTranslations("TaskTemplates");
  const texts = useTaskTexts(noMembers);
  const [creating, setCreating] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TaskTemplateSummary | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();

  const create = useTaskMutation(
    `template-create:${draftId}`,
    (input: CreateTemplateInput) =>
      sendTaskRequest<RevisionResponse>("POST", TASK_TEMPLATES_ENDPOINT, input),
    () => {
      announce(t("announceCreated"));
      setCreating(false);
      setDraftId(crypto.randomUUID());
      requestAnimationFrame(() => createButton.current?.focus());
    },
  );
  const remove = useTaskMutation(
    "template-delete",
    (template: TaskTemplateSummary) =>
      sendTaskRequest<object>("DELETE", templateUrl(template.id), {
        expectedRevision: template.revision,
      }),
    () => {
      announce(t("announceDeleted"));
      setDeleting(null);
    },
  );

  return (
    <HydrationGate>
      {region}
      <section aria-labelledby="templates-heading" className="flex flex-col gap-4">
        <h2 id="templates-heading" className="text-section-title font-semibold text-fg">
          {t("libraryHeading")}
        </h2>
        <p className="text-body text-fg-muted">
          {canManage ? t("libraryIntroManager") : t("libraryIntroMember")}
        </p>
        {templates.length === 0 ? (
          <p className="text-body text-fg-muted" data-testid="templates-empty">
            {t("empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="template-list">
            {templates.map((template) => (
              <li
                key={template.id}
                className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
                data-testid="template"
              >
                <p className="text-body font-semibold text-fg">
                  <bdi>{template.name}</bdi>
                </p>
                <p className="text-body text-fg">
                  {t("summary", {
                    title: template.title,
                    labels: template.labelCount,
                    items: template.subtaskCount,
                  })}
                  {template.priority ? ` · ${texts.priority(template.priority)}` : null}
                </p>
                {canManage && editing !== template.id ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setEditing(template.id);
                      }}
                      aria-label={t("editNamed", { name: template.name })}
                    >
                      {t("edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        remove.reset();
                        setDeleting(template);
                      }}
                      aria-label={t("deleteNamed", { name: template.name })}
                    >
                      {t("delete")}
                    </Button>
                  </div>
                ) : null}
                {editing === template.id ? (
                  <EditTemplate
                    id={template.id}
                    labels={labels}
                    onDone={(saved) => {
                      setEditing(null);
                      if (saved) announce(t("announceSaved"));
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          creating ? (
            <div className="rounded-card border border-line bg-surface p-4">
              <h3 className="mb-3 text-body font-semibold text-fg">{t("newHeading")}</h3>
              <TemplateForm
                defaults={{
                  name: "",
                  title: "",
                  description: "",
                  priority: "",
                  labelIds: [],
                  checklist: "",
                }}
                labels={labels}
                busy={create.busy}
                submitLabel={t("create")}
                onSubmit={(values) => {
                  create.mutate({
                    id: draftId,
                    homeId,
                    name: values.name,
                    title: values.title,
                    description: values.description,
                    priority: values.priority,
                    labelIds: values.labelIds,
                    subtasks: values.checklist,
                  });
                }}
                onCancel={() => {
                  setCreating(false);
                  create.reset();
                  requestAnimationFrame(() => createButton.current?.focus());
                }}
              />
              <div className="mt-3">
                <Failure error={create.error} />
              </div>
            </div>
          ) : (
            <div>
              <Button
                ref={createButton}
                disabled={templates.length >= TASK_LIMITS.templates}
                onClick={() => {
                  setCreating(true);
                }}
              >
                {t("new")}
              </Button>
              {templates.length >= TASK_LIMITS.templates ? (
                <p className="mt-2 text-helper text-fg-muted">
                  {t("limit", { max: TASK_LIMITS.templates })}
                </p>
              ) : null}
            </div>
          )
        ) : null}
      </section>
      {deleting ? (
        <Dialog
          open
          onClose={() => {
            setDeleting(null);
          }}
          title={t("deleteTitle", { name: deleting.name })}
          closeLabel={t("close")}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setDeleting(null);
                }}
                disabled={remove.busy}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                loading={remove.busy}
                onClick={() => {
                  remove.mutate(deleting);
                }}
                data-testid="template-delete-confirm"
              >
                {t("delete")}
              </Button>
            </>
          }
        >
          <p className="text-body text-fg">{t("deleteText")}</p>
          <Failure error={remove.error} />
        </Dialog>
      ) : null}
    </HydrationGate>
  );
}

function EditTemplate({
  id,
  labels,
  onDone,
}: {
  readonly id: string;
  readonly labels: readonly LabelOption[];
  readonly onDone: (saved: boolean) => void;
}) {
  const t = useTranslations("TaskTemplates");
  const texts = useTaskTexts(noMembers);
  const template = useQuery<TaskTemplate, TaskRequestError>({
    queryKey: templateKey(id),
    queryFn: () => fetchTemplate(id),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const save = useTaskMutation(
    `template:${id}`,
    (input: UpdateTemplateInput) =>
      sendTaskRequest<RevisionResponse>("PATCH", templateUrl(id), input),
    () => {
      onDone(true);
    },
  );
  if (template.isPending) return <p className="text-body text-fg-muted">{t("loading")}</p>;
  if (template.isError) {
    return <p className="text-body text-danger">{texts.failure(template.error.failure)}</p>;
  }
  const value = template.data;
  return (
    <>
      <TemplateForm
        defaults={{
          name: value.name,
          title: value.title,
          description: value.description ?? "",
          priority: value.priority ?? "",
          labelIds: [...value.labelIds],
          checklist: value.subtasks.join("\n"),
        }}
        labels={labels}
        omittedLabels={value.omittedLabels}
        busy={save.busy}
        submitLabel={t("save")}
        onSubmit={(values) => {
          save.mutate({
            expectedRevision: value.revision,
            name: values.name,
            title: values.title,
            description: values.description,
            priority: values.priority,
            labelIds: values.labelIds,
            subtasks: values.checklist,
          });
        }}
        onCancel={() => {
          onDone(false);
        }}
      />
      <Failure error={save.error} />
    </>
  );
}

export interface SaveAsTemplateProps {
  readonly task: Pick<
    TaskDetail,
    "homeId" | "title" | "description" | "priority" | "labels" | "subtasks"
  >;
  readonly labels: readonly LabelOption[];
}

/**
 * Saves a task's reusable content as a new template (S19b): title, description, priority, labels and
 * the checklist's item titles, editable before saving. Never its dates, assignees, comments,
 * completion, reminder or repeat schedule.
 */
export function SaveAsTemplate({ task, labels }: SaveAsTemplateProps) {
  const t = useTranslations("TaskTemplates");
  const [open, setOpen] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const { announce, region } = useAnnouncer();
  const create = useTaskMutation(
    `template-create:${draftId}`,
    (input: CreateTemplateInput) =>
      sendTaskRequest<RevisionResponse>("POST", TASK_TEMPLATES_ENDPOINT, input),
    () => {
      setOpen(false);
      setDraftId(crypto.randomUUID());
      announce(t("announceCreated"));
    },
  );
  return (
    <HydrationGate>
      {region}
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            create.reset();
            setOpen(true);
          }}
          data-testid="save-as-template"
        >
          {t("saveAs")}
        </Button>
      </div>
      {open ? (
        <Dialog
          open
          onClose={() => {
            setOpen(false);
          }}
          title={t("saveAsTitle")}
          description={t("saveAsText")}
          closeLabel={t("close")}
        >
          <TemplateForm
            defaults={{
              name: task.title.slice(0, TASK_LIMITS.templateName),
              title: task.title,
              description: task.description ?? "",
              priority: task.priority ?? "",
              labelIds: task.labels.map((label) => label.id),
              checklist: task.subtasks.map((subtask) => subtask.title).join("\n"),
            }}
            labels={labels}
            busy={create.busy}
            submitLabel={t("create")}
            onSubmit={(values) => {
              create.mutate({
                id: draftId,
                homeId: task.homeId,
                name: values.name,
                title: values.title,
                description: values.description,
                priority: values.priority,
                labelIds: values.labelIds,
                subtasks: values.checklist,
              });
            }}
            onCancel={() => {
              setOpen(false);
            }}
          />
          <Failure error={create.error} />
        </Dialog>
      ) : null}
    </HydrationGate>
  );
}

export interface FromTemplateProps {
  readonly templates: readonly TaskTemplateSummary[];
  readonly lists: readonly { readonly id: string; readonly name: string }[];
  readonly defaultListId: string;
  readonly labels: readonly LabelOption[];
  readonly onCreated: () => void;
  readonly onCancel: () => void;
}

/**
 * Creates a task from a template (S19b): pick a template, review and edit what the task starts with
 * (title, description, priority, labels, checklist, list and optional dates), then create it. The
 * task and its whole checklist are created at once with a fresh id, so a retry never makes a
 * second task. If the template changed meanwhile, the preview reloads and nothing is created.
 */
export function FromTemplate({
  templates,
  lists,
  defaultListId,
  labels,
  onCreated,
  onCancel,
}: FromTemplateProps) {
  const t = useTranslations("TaskTemplates");
  const tTasksErrors = useTranslations("Tasks");
  const texts = useTaskTexts(noMembers);
  const [chosen, setChosen] = useState(templates[0]?.id ?? "");
  const [changed, setChanged] = useState(false);
  const template = useQuery<TaskTemplate, TaskRequestError>({
    queryKey: templateKey(chosen),
    queryFn: () => fetchTemplate(chosen),
    enabled: chosen !== "",
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });

  return (
    <div className="flex flex-col gap-4" data-testid="from-template">
      <SelectField
        label={t("chooseTemplate")}
        options={templates.map((option) => ({ value: option.id, label: option.name }))}
        value={chosen}
        onChange={(event) => {
          setChanged(false);
          setChosen(event.target.value);
        }}
      />
      {changed ? (
        <FormAlert tone="info" announce>
          <p>{tTasksErrors("errorTemplateChanged")}</p>
        </FormAlert>
      ) : null}
      {template.isPending ? (
        <p className="text-body text-fg-muted">{t("loading")}</p>
      ) : template.isError ? (
        <p className="text-body text-danger">{texts.failure(template.error.failure)}</p>
      ) : (
        <TemplateTaskForm
          // A new preview whenever the template or its revision changes.
          key={`${template.data.id}:${String(template.data.revision)}`}
          template={template.data}
          lists={lists}
          defaultListId={defaultListId}
          labels={labels}
          onChanged={() => {
            setChanged(true);
            void template.refetch();
          }}
          onCreated={onCreated}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

function TemplateTaskForm({
  template,
  lists,
  defaultListId,
  labels,
  onChanged,
  onCreated,
  onCancel,
}: {
  readonly template: TaskTemplate;
  readonly lists: readonly { readonly id: string; readonly name: string }[];
  readonly defaultListId: string;
  readonly labels: readonly LabelOption[];
  readonly onChanged: () => void;
  readonly onCreated: () => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations("TaskTemplates");
  const tTasks = useTranslations("Tasks");
  const message = useFieldMessage();
  const priorities = usePriorityOptions();
  const [taskId] = useState(() => crypto.randomUUID());
  const create = useTaskMutation(
    `task-create:${taskId}`,
    async (input: CreateFromTemplateInput) => {
      try {
        return await sendTaskRequest<RevisionResponse>(
          "POST",
          `${templateUrl(template.id)}/tasks`,
          input,
        );
      } catch (error) {
        // The template changed since this preview: show the new one, create nothing.
        if (error instanceof TaskRequestError && error.failure === "templateChanged") onChanged();
        throw error;
      }
    },
    onCreated,
  );
  const form = useForm<FromTemplateInput, unknown, FromTemplateOutput>({
    resolver: zodResolver(fromTemplateSchema),
    defaultValues: {
      title: template.title,
      description: template.description ?? "",
      priority: template.priority ?? "",
      labelIds: [...template.labelIds],
      checklist: template.subtasks.join("\n"),
      listId: defaultListId,
      startDate: "",
      dueDate: "",
    },
  });
  const errors = form.formState.errors;

  return (
    <form
      noValidate
      aria-label={t("previewLabel", { name: template.name })}
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          create.mutate({
            taskId,
            expectedTemplateRevision: template.revision,
            listId: values.listId,
            title: values.title,
            description: values.description,
            priority: values.priority,
            labelIds: values.labelIds,
            subtasks: values.checklist,
            startDate: values.startDate,
            dueDate: values.dueDate,
          });
        })(event);
      }}
      className="flex flex-col gap-4"
      data-testid="template-task-form"
    >
      <p className="text-helper text-fg-muted">{t("previewHelp")}</p>
      <TextField
        label={tTasks("fieldTitle")}
        required
        autoComplete="off"
        error={message(errors.title)}
        {...form.register("title")}
      />
      <SelectField
        label={tTasks("fieldList")}
        options={lists.map((list) => ({ value: list.id, label: list.name }))}
        {...form.register("listId")}
      />
      <TextArea
        label={tTasks("fieldDescription")}
        rows={3}
        error={message(errors.description)}
        {...form.register("description")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          type="date"
          label={tTasks("fieldStartDate")}
          error={message(errors.startDate)}
          {...form.register("startDate")}
        />
        <TextField
          type="date"
          label={tTasks("fieldDueDate")}
          error={message(errors.dueDate)}
          {...form.register("dueDate")}
        />
      </div>
      <SelectField
        label={tTasks("fieldPriority")}
        options={priorities}
        {...form.register("priority")}
      />
      {template.omittedLabels > 0 ? (
        <p className="text-helper text-fg" data-testid="omitted-labels">
          {t("omittedLabels", { count: template.omittedLabels })}
        </p>
      ) : null}
      <Controller
        control={form.control}
        name="labelIds"
        render={({ field }) => (
          <LabelPicker labels={labels} value={field.value} onChange={field.onChange} />
        )}
      />
      <TextArea
        label={t("fieldChecklist")}
        description={t("fieldChecklistHelp", { max: TASK_LIMITS.subtasks })}
        rows={4}
        error={message(errors.checklist)}
        {...form.register("checklist")}
      />
      {create.error && create.error.failure !== "templateChanged" ? (
        <Failure error={create.error} />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={create.busy}>
          {t("createTask")}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={create.busy}>
          {tTasks("cancel")}
        </Button>
      </div>
    </form>
  );
}
