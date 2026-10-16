"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { focusOnMount } from "@/components/ui/focus-on-mount";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { isolate } from "@/invitations/format";
import {
  sendTaskRequest,
  SUBTASKS_ENDPOINT,
  TASKS_ENDPOINT,
  TaskRequestError,
  type Subtask,
  type TaskDetail,
} from "@/tasks/api";
import { noMembers } from "@/tasks/format";
import { TASK_LIMITS, taskTitleSchema } from "@/tasks/schema";

import { HydrationGate } from "./hydration-gate";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

type SubtaskChange =
  | { readonly kind: "add"; readonly id: string; readonly title: string }
  | { readonly kind: "tick"; readonly subtask: Subtask; readonly completed: boolean }
  | { readonly kind: "rename"; readonly subtask: Subtask; readonly title: string }
  | { readonly kind: "order"; readonly ids: readonly string[]; readonly moved: Subtask }
  | { readonly kind: "delete"; readonly subtask: Subtask };

/**
 * A task's single-level checklist (S18): progress as "done of total", tick, rename, reorder with
 * Move up / Move down buttons (no drag needed), and remove with confirmation, for whoever may edit
 * the task. Ticking every subtask never completes the task. Read-only for everyone else.
 */
export function TaskSubtasks({ task }: { readonly task: TaskDetail }) {
  const t = useTranslations("Tasks");
  const texts = useTaskTexts(noMembers);
  const [newTitle, setNewTitle] = useState("");
  const [newId, setNewId] = useState(() => crypto.randomUUID());
  const [titleError, setTitleError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly title: string } | null>(
    null,
  );
  const [removing, setRemoving] = useState<Subtask | null>(null);
  // A tick shows at once; it counts only for the revision it was made on, so the refreshed
  // checklist (a new revision) takes over, and a refusal puts the box back.
  const [ticked, setTicked] = useState<
    ReadonlyMap<string, { readonly revision: number; readonly completed: boolean }>
  >(new Map());
  const shown = (subtask: Subtask) => {
    const tick = ticked.get(subtask.id);
    return tick?.revision === subtask.revision ? tick.completed : subtask.completed;
  };
  const addField = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { announce, region } = useAnnouncer();
  const subtasks = task.subtasks;
  const done = subtasks.filter((subtask) => subtask.completed).length;
  const full = subtasks.length >= TASK_LIMITS.subtasks;

  const mutation = useTaskMutation(
    `task:${task.id}:subtasks`,
    async (change: SubtaskChange) => {
      switch (change.kind) {
        case "add":
          return sendTaskRequest("POST", `${TASKS_ENDPOINT}/${task.id}/subtasks`, {
            id: change.id,
            title: change.title,
          });
        case "tick":
          return sendTaskRequest("PATCH", `${SUBTASKS_ENDPOINT}/${change.subtask.id}`, {
            completed: change.completed,
          });
        case "rename":
          return sendTaskRequest("PATCH", `${SUBTASKS_ENDPOINT}/${change.subtask.id}`, {
            expectedRevision: change.subtask.revision,
            title: change.title,
          });
        case "order":
          return sendTaskRequest("PUT", `${TASKS_ENDPOINT}/${task.id}/subtasks`, {
            ids: change.ids,
          });
        case "delete":
          return sendTaskRequest("DELETE", `${SUBTASKS_ENDPOINT}/${change.subtask.id}`, {});
      }
    },
    (_result, change) => {
      switch (change.kind) {
        case "add":
          setNewTitle("");
          setNewId(crypto.randomUUID());
          announce(t("announceSubtaskAdded", { subtask: isolate(change.title) }));
          addField.current?.focus();
          break;
        case "tick":
          announce(
            change.completed
              ? t("announceSubtaskDone", { subtask: isolate(change.subtask.title) })
              : t("announceSubtaskOpen", { subtask: isolate(change.subtask.title) }),
          );
          break;
        case "rename":
          setRenaming(null);
          announce(t("announceSubtaskRenamed"));
          headingRef.current?.focus();
          break;
        case "order":
          announce(t("announceSubtaskMoved", { subtask: isolate(change.moved.title) }));
          break;
        case "delete":
          announce(t("announceSubtaskRemoved", { subtask: isolate(change.subtask.title) }));
          // The removed row is gone: keep the keyboard in the checklist (S17 review M3).
          headingRef.current?.focus();
          break;
      }
    },
    (change) => {
      if (change.kind !== "tick") return;
      setTicked((previous) => {
        const next = new Map(previous);
        next.delete(change.subtask.id);
        return next;
      });
    },
  );

  function move(subtask: Subtask, offset: -1 | 1) {
    const ids = subtasks.map((item) => item.id);
    const from = ids.indexOf(subtask.id);
    const to = from + offset;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to] ?? "", ids[from] ?? ""];
    mutation.mutate({ kind: "order", ids, moved: subtask });
  }

  function add() {
    const parsed = taskTitleSchema.safeParse(newTitle);
    if (!parsed.success) {
      setTitleError(
        parsed.error.issues[0]?.message === "tooLong" ? t("fieldTooLong") : t("fieldRequired"),
      );
      return;
    }
    setTitleError(null);
    mutation.mutate({ kind: "add", id: newId, title: parsed.data });
  }

  const fieldMessage = (code: string | undefined) =>
    code === "tooLong" ? t("fieldTooLong") : t("fieldRequired");
  const editable = task.can.edit;
  const error = mutation.error instanceof TaskRequestError ? mutation.error : null;

  return (
    <section aria-labelledby="task-subtasks-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2
          id="task-subtasks-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-section-title font-semibold text-fg outline-none"
        >
          {t("subtasksHeading")}
        </h2>
        <p className="text-body text-fg-muted" data-testid="subtask-progress">
          {subtasks.length === 0
            ? t("subtasksEmpty")
            : t("subtaskProgress", { done, total: subtasks.length })}
        </p>
        {subtasks.length > 0 ? (
          <ul className="flex flex-col gap-2" data-testid="subtask-list">
            {subtasks.map((subtask, index) => (
              <li
                key={subtask.id}
                className="flex flex-wrap items-center gap-2"
                data-testid="subtask"
              >
                {renaming?.id === subtask.id ? (
                  <form
                    className="flex flex-1 flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const parsed = taskTitleSchema.safeParse(renaming.title);
                      if (parsed.success) {
                        mutation.mutate({ kind: "rename", subtask, title: parsed.data });
                      } else {
                        announce(fieldMessage(parsed.error.issues[0]?.message));
                      }
                    }}
                  >
                    <TextField
                      label={t("subtaskRenameLabel", { subtask: subtask.title })}
                      value={renaming.title}
                      ref={focusOnMount}
                      onChange={(event) => {
                        setRenaming({ id: subtask.id, title: event.target.value });
                      }}
                    />
                    <Button type="submit" size="sm" loading={mutation.busy}>
                      {t("save")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRenaming(null);
                        headingRef.current?.focus();
                      }}
                    >
                      {t("cancel")}
                    </Button>
                  </form>
                ) : (
                  <>
                    {editable ? (
                      <Checkbox
                        label={subtask.title}
                        checked={shown(subtask)}
                        disabled={mutation.busy}
                        className="flex-1"
                        onChange={(event) => {
                          const completed = event.target.checked;
                          setTicked((previous) =>
                            new Map(previous).set(subtask.id, {
                              revision: subtask.revision,
                              completed,
                            }),
                          );
                          mutation.mutate({ kind: "tick", subtask, completed });
                        }}
                      />
                    ) : (
                      <p className="flex-1 text-body text-fg">
                        <bdi>{subtask.title}</bdi>{" "}
                        <span className="text-helper text-fg-muted">
                          {subtask.completed ? t("statusDone") : t("statusOpen")}
                        </span>
                      </p>
                    )}
                    {editable ? (
                      <span className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={index === 0 || mutation.busy}
                          aria-label={t("subtaskMoveUp", { subtask: subtask.title })}
                          onClick={() => {
                            move(subtask, -1);
                          }}
                        >
                          {t("moveUp")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={index === subtasks.length - 1 || mutation.busy}
                          aria-label={t("subtaskMoveDown", { subtask: subtask.title })}
                          onClick={() => {
                            move(subtask, 1);
                          }}
                        >
                          {t("moveDown")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t("subtaskRename", { subtask: subtask.title })}
                          onClick={() => {
                            setRenaming({ id: subtask.id, title: subtask.title });
                          }}
                        >
                          {t("rename")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t("subtaskRemove", { subtask: subtask.title })}
                          onClick={() => {
                            setRemoving(subtask);
                          }}
                        >
                          {t("remove")}
                        </Button>
                      </span>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {editable ? (
          <form
            className="flex flex-wrap items-end gap-2"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <TextField
              ref={addField}
              label={t("subtaskAdd")}
              value={newTitle}
              error={titleError ?? undefined}
              disabled={full}
              {...(full ? { description: t("subtasksFull") } : {})}
              onChange={(event) => {
                setNewTitle(event.target.value);
              }}
              autoComplete="off"
              data-testid="subtask-new"
            />
            <Button type="submit" variant="secondary" loading={mutation.busy} disabled={full}>
              {t("add")}
            </Button>
          </form>
        ) : null}
        {error ? (
          <FormAlert tone="error" announce>
            {texts.failure(error.failure)}
          </FormAlert>
        ) : null}
        <Dialog
          open={removing !== null}
          onClose={() => {
            setRemoving(null);
          }}
          title={t("confirmRemoveSubtaskTitle")}
          description={
            removing ? t("confirmRemoveSubtaskBody", { subtask: isolate(removing.title) }) : ""
          }
          closeLabel={t("close")}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setRemoving(null);
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const subtask = removing;
                  setRemoving(null);
                  if (subtask) mutation.mutate({ kind: "delete", subtask });
                }}
              >
                {t("remove")}
              </Button>
            </>
          }
        />
      </HydrationGate>
    </section>
  );
}
