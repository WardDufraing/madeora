"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { sendTaskRequest, TASKS_ENDPOINT, type RevisionResponse } from "@/tasks/api";
import { noMembers, type MemberOption } from "@/tasks/format";
import type { CreateTaskInput } from "@/tasks/schema";

import type { LabelOption } from "./label-picker";
import { TaskForm, type TaskFormInput, type TaskFormOutput } from "./task-form";
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
}

/**
 * Adding a task (S18). Each opening of the form gets a fresh id, so a retry after a lost answer finds
 * the task already there instead of creating a second one.
 */
export function NewTask({ homeId, lists, defaultListId, labels, members }: NewTaskProps) {
  const t = useTranslations("Tasks");
  const texts = useTaskTexts(noMembers);
  const [open, setOpen] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [formKey, setFormKey] = useState(0);
  const opener = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const mutation = useTaskMutation(
    `task-create:${draftId}`,
    (input: CreateTaskInput) => sendTaskRequest<RevisionResponse>("POST", TASKS_ENDPOINT, input),
    () => {
      announce(t("announceCreated"));
      // A new draft: a new id and an empty form, focus back in the title for the next task.
      setDraftId(crypto.randomUUID());
      setFormKey((key) => key + 1);
    },
  );

  const firstList = defaultListId ?? lists[0]?.id ?? "";
  const defaults: TaskFormInput = {
    title: "",
    description: "",
    startDate: "",
    dueDate: "",
    priority: "",
    labelIds: [],
    listId: firstList,
    assigneeIds: [],
  };

  function submit(values: TaskFormOutput) {
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
    });
  }

  return (
    <section aria-labelledby="new-task-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="new-task-heading" className="sr-only">
          {t("newTaskHeading")}
        </h2>
        {!open ? (
          <div>
            <Button
              ref={opener}
              onClick={() => {
                setOpen(true);
              }}
              disabled={lists.length === 0}
              data-testid="new-task-open"
            >
              {t("newTask")}
            </Button>
          </div>
        ) : (
          <div className="rounded-card border border-line bg-surface p-4">
            <TaskForm
              key={formKey}
              mode="create"
              defaults={defaults}
              labels={labels}
              lists={lists}
              members={members}
              busy={mutation.busy}
              onSubmit={submit}
              onCancel={() => {
                setOpen(false);
                mutation.reset();
                // The opener comes back; focus returns to it (S17 review M3).
                requestAnimationFrame(() => opener.current?.focus());
              }}
              submitLabel={t("addTask")}
              focusTitle
            />
            {mutation.error ? (
              <FormAlert tone="error" announce className="mt-3">
                {texts.failure(mutation.error.failure)}
              </FormAlert>
            ) : null}
          </div>
        )}
      </HydrationGate>
    </section>
  );
}
