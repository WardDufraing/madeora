"use client";

import { PlusIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import type { DateFormat } from "@/preferences/schema";
import {
  sendTaskRequest,
  TASK_LIST_WITH_TASK_ENDPOINT,
  TASKS_ENDPOINT,
  type RevisionResponse,
  type TaskTemplateSummary,
} from "@/tasks/api";
import { noMembers, type MemberOption } from "@/tasks/format";
import { listNameSchema, type CreateTaskInput } from "@/tasks/schema";

import type { LabelOption } from "./label-picker";
import { noRepeat } from "./repeat-fields";
import { TaskForm, type TaskFormInput, type TaskFormOutput } from "./task-form";
import { FromTemplate } from "./task-templates";
import { HydrationGate } from "./hydration-gate";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

export interface NewTaskProps {
  readonly homeId: string | null;
  readonly lists: readonly { readonly id: string; readonly name: string }[];
  /** The list being viewed, chosen first. */
  readonly defaultListId: string | null;
  readonly labels: readonly LabelOption[];
  /** Assignable members, only when the viewer manages tasks in this Home. */
  readonly members: readonly MemberOption[];
  readonly dateFormat: DateFormat;
  /** S19b: the context's templates, to start a task from one. */
  readonly templates?: readonly TaskTemplateSummary[];
  /**
   * `dialog` is the page header's **+ New Task** (a dialog); `inline` is the "Add a task" field of
   * a task group (redesign decisions 46, 55). Both use the same quick form.
   */
  readonly placement?: "dialog" | "inline";
  /** A due date to start from (the Today group presets today). */
  readonly defaultDueDate?: string;
  /** Whether the viewer may create a list, which a first task needs when there is none (UX4a). */
  readonly canCreateList?: boolean;
  /** The inline trigger's text; default "Add a task". */
  readonly triggerLabel?: string;
}

/** What an inline "Add a task" needs from the page (serialisable, so a server page can pass it). */
export type TaskCreation = Pick<
  NewTaskProps,
  | "lists"
  | "defaultListId"
  | "labels"
  | "members"
  | "dateFormat"
  | "canCreateList"
  | "defaultDueDate"
>;

/**
 * Adding a task (S18), optionally repeating (S19: its due date is the first date). Quick first
 * (title, list, due date, priority), with **More options** for the rest (redesign decision 55).
 * Each opening of the form gets a fresh id, so a retry after a lost answer finds the task already
 * there instead of creating a second one. With no list yet, the form asks for the first list's
 * name and creates the list and the task together, only after that explicit step (UX4a).
 */
export function NewTask({
  homeId,
  lists,
  defaultListId,
  labels,
  members,
  dateFormat,
  templates = [],
  placement = "dialog",
  defaultDueDate = "",
  canCreateList = true,
  triggerLabel,
}: NewTaskProps) {
  const t = useTranslations("Tasks");
  const tTemplates = useTranslations("TaskTemplates");
  const headingId = useId();
  const [fromTemplate, setFromTemplate] = useState(false);
  const texts = useTaskTexts(noMembers);
  const [open, setOpen] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [listDraftId, setListDraftId] = useState(() => crypto.randomUUID());
  const [formKey, setFormKey] = useState(0);
  const [listName, setListName] = useState("");
  const [listNameError, setListNameError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const needsList = lists.length === 0;
  const mutation = useTaskMutation(
    `task-create:${draftId}`,
    (input: CreateTaskInput) =>
      needsList
        ? sendTaskRequest<RevisionResponse>("POST", TASK_LIST_WITH_TASK_ENDPOINT, {
            homeId: input.homeId,
            list: { id: listDraftId, name: listName.trim() },
            task: {
              id: input.id,
              title: input.title,
              description: input.description,
              startDate: input.startDate,
              dueDate: input.dueDate,
              priority: input.priority,
              labelIds: input.labelIds,
              assigneeIds: input.assigneeIds,
            },
          })
        : sendTaskRequest<RevisionResponse>("POST", TASKS_ENDPOINT, input),
    () => {
      announce(t("announceCreated"));
      setAdded(true);
      // A new draft: a new id and an empty form, focus back in the title for the next task.
      setDraftId(crypto.randomUUID());
      setListDraftId(crypto.randomUUID());
      setListName("");
      setFormKey((key) => key + 1);
    },
  );

  const firstList = defaultListId ?? lists[0]?.id ?? "";
  const defaults: TaskFormInput = {
    title: "",
    description: "",
    startDate: "",
    dueDate: defaultDueDate,
    priority: "",
    labelIds: [],
    listId: firstList,
    assigneeIds: [],
    repeat: noRepeat,
  };

  function close() {
    setOpen(false);
    setFromTemplate(false);
    setAdded(false);
    setListNameError(null);
    mutation.reset();
    // The opener comes back; focus returns to it (S17 review M3).
    requestAnimationFrame(() => opener.current?.focus());
  }

  function submit(values: TaskFormOutput) {
    if (needsList) {
      const parsed = listNameSchema.safeParse(listName);
      if (!parsed.success) {
        setListNameError(t("firstListNameInvalid"));
        return;
      }
    }
    setListNameError(null);
    setAdded(false);
    mutation.mutate({
      id: draftId,
      homeId,
      listId: values.listId,
      title: values.title,
      description: values.description,
      startDate: values.startDate,
      dueDate: values.dueDate,
      priority: values.priority,
      labelIds: [...values.labelIds],
      assigneeIds: [...values.assigneeIds],
      recurrence:
        values.repeat && values.dueDate ? { ...values.repeat, startsOn: values.dueDate } : null,
    });
  }

  const blocked = needsList && !canCreateList;
  const form = blocked ? (
    <p className="text-body text-fg-muted">{t("noListsMember")}</p>
  ) : (
    <>
      {needsList ? (
        <p className="text-helper text-fg-muted" data-testid="first-list-note">
          {t("firstListNote")}
        </p>
      ) : null}
      <TaskForm
        key={formKey}
        mode="create"
        defaults={defaults}
        labels={labels}
        lists={lists}
        members={members}
        busy={mutation.busy}
        onSubmit={submit}
        onCancel={close}
        submitLabel={t("addTask")}
        focusTitle
        repeatable
        quick
        dateFormat={dateFormat}
        extraField={
          needsList ? (
            <TextField
              label={t("firstListName")}
              description={t("firstListNameHelp")}
              autoComplete="off"
              required
              value={listName}
              onChange={(event) => {
                setListName(event.target.value);
              }}
              error={listNameError ?? undefined}
            />
          ) : undefined
        }
      />
      {added && !mutation.error ? (
        <p role="status" className="mt-3 text-helper text-success" data-testid="task-added">
          {t("addedMessage")}
        </p>
      ) : null}
      {mutation.error ? (
        <FormAlert tone="error" announce className="mt-3">
          {texts.failure(mutation.error.failure, mutation.error.detail)}
        </FormAlert>
      ) : null}
    </>
  );

  if (placement === "inline") {
    return (
      <div className="flex flex-col gap-2" data-testid="inline-add">
        <HydrationGate>
          {region}
          {!open ? (
            <button
              ref={opener}
              type="button"
              onClick={() => {
                setOpen(true);
              }}
              disabled={blocked}
              className="press-feedback inline-flex min-h-10 items-center gap-2 self-start rounded-control px-2 text-body text-fg-muted hover:bg-accent-subtle hover:text-fg disabled:opacity-60"
              data-testid="inline-add-open"
            >
              <PlusIcon size="sm" />
              {triggerLabel ?? t("addATask")}
            </button>
          ) : (
            <section
              aria-labelledby={headingId}
              className="rounded-card border border-line bg-surface p-widget-padding shadow-raised"
            >
              <h3 id={headingId} className="sr-only">
                {t("newTaskHeading")}
              </h3>
              {form}
            </section>
          )}
        </HydrationGate>
      </div>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-wrap gap-2">
      <HydrationGate>
        {region}
        <h2 id={headingId} className="sr-only">
          {t("newTaskHeading")}
        </h2>
        <Button
          ref={opener}
          onClick={() => {
            setOpen(true);
          }}
          disabled={blocked}
          data-testid="new-task-open"
        >
          <PlusIcon size="sm" />
          {t("newTask")}
        </Button>
        {templates.length > 0 ? (
          <Button
            variant="secondary"
            onClick={() => {
              setFromTemplate(true);
              setOpen(true);
            }}
            disabled={lists.length === 0}
            data-testid="new-task-from-template"
          >
            {tTemplates("fromTemplate")}
          </Button>
        ) : null}
        <Dialog
          open={open}
          onClose={close}
          title={fromTemplate ? tTemplates("fromTemplate") : t("newTask")}
          closeLabel={t("close")}
          size="default"
        >
          {!open ? null : fromTemplate ? (
            <FromTemplate
              templates={templates}
              lists={lists}
              defaultListId={firstList}
              labels={labels}
              onCreated={() => {
                announce(t("announceCreated"));
                close();
              }}
              onCancel={close}
            />
          ) : (
            form
          )}
        </Dialog>
      </HydrationGate>
    </section>
  );
}
