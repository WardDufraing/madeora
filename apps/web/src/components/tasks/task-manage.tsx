"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { focusOnMount } from "@/components/ui/focus-on-mount";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { isolate } from "@/invitations/format";
import {
  sendTaskRequest,
  TASK_LABELS_ENDPOINT,
  TASK_LISTS_ENDPOINT,
  TaskRequestError,
  type TaskLabel,
  type TaskListSummary,
} from "@/tasks/api";
import { noMembers } from "@/tasks/format";
import {
  isLabelColor,
  labelColors,
  labelNameSchema,
  listNameSchema,
  type LabelColor,
} from "@/tasks/schema";

import { LabelChip } from "./label-chip";
import { HydrationGate } from "./hydration-gate";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

/** The message for a name the schema refused. */
function useFieldMessage(): (code: string | undefined) => string {
  const t = useTranslations("Tasks");
  return (code) => (code === "tooLong" ? t("fieldTooLong") : t("fieldRequired"));
}

type ListChange =
  | { readonly kind: "create"; readonly id: string; readonly name: string }
  | { readonly kind: "rename"; readonly list: TaskListSummary; readonly name: string }
  | { readonly kind: "archive"; readonly list: TaskListSummary; readonly archived: boolean }
  | { readonly kind: "order"; readonly ids: readonly string[]; readonly moved: TaskListSummary }
  | { readonly kind: "delete"; readonly list: TaskListSummary };

/**
 * Managing a context's task lists (S18): create, rename, reorder (Move up / down), archive and
 * unarchive, and delete to the trash. Archiving or deleting first shows what is in the way: a list
 * with open tasks cannot be archived and a list with tasks cannot be deleted until they are moved,
 * completed or deleted, so no task is hidden silently.
 */
export function ManageLists({
  homeId,
  lists,
}: {
  readonly homeId: string | null;
  readonly lists: readonly TaskListSummary[];
}) {
  const t = useTranslations("Tasks");
  const texts = useTaskTexts(noMembers);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly name: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<TaskListSummary | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const { announce, region } = useAnnouncer();
  const fieldMessage = useFieldMessage();
  const active = lists.filter((list) => !list.archived);
  const archived = lists.filter((list) => list.archived);

  const mutation = useTaskMutation(
    `task-lists:${homeId ?? "personal"}`,
    (change: ListChange) => {
      switch (change.kind) {
        case "create":
          return sendTaskRequest("POST", TASK_LISTS_ENDPOINT, {
            id: change.id,
            homeId,
            name: change.name,
          });
        case "rename":
          return sendTaskRequest("PATCH", `${TASK_LISTS_ENDPOINT}/${change.list.id}`, {
            expectedRevision: change.list.revision,
            name: change.name,
            archived: change.list.archived,
          });
        case "archive":
          return sendTaskRequest("PATCH", `${TASK_LISTS_ENDPOINT}/${change.list.id}`, {
            expectedRevision: change.list.revision,
            name: change.list.name,
            archived: change.archived,
          });
        case "order":
          return sendTaskRequest("PUT", TASK_LISTS_ENDPOINT, { homeId, ids: change.ids });
        case "delete":
          return sendTaskRequest("DELETE", `${TASK_LISTS_ENDPOINT}/${change.list.id}`, {
            expectedRevision: change.list.revision,
          });
      }
    },
    (_result, change) => {
      switch (change.kind) {
        case "create":
          setName("");
          setDraftId(crypto.randomUUID());
          announce(t("announceListCreated", { list: isolate(change.name) }));
          nameField.current?.focus();
          break;
        case "rename":
          setRenaming(null);
          announce(t("announceListRenamed"));
          headingRef.current?.focus();
          break;
        case "archive":
          announce(
            change.archived
              ? t("announceListArchived", { list: isolate(change.list.name) })
              : t("announceListUnarchived", { list: isolate(change.list.name) }),
          );
          headingRef.current?.focus();
          break;
        case "order":
          announce(t("announceListMoved", { list: isolate(change.moved.name) }));
          break;
        case "delete":
          announce(t("announceListDeleted", { list: isolate(change.list.name) }));
          headingRef.current?.focus();
          break;
      }
    },
  );

  function move(list: TaskListSummary, offset: -1 | 1) {
    const ids = active.map((item) => item.id);
    const from = ids.indexOf(list.id);
    const to = from + offset;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to] ?? "", ids[from] ?? ""];
    mutation.mutate({ kind: "order", ids, moved: list });
  }

  const error = mutation.error instanceof TaskRequestError ? mutation.error : null;

  function row(list: TaskListSummary, index: number) {
    return (
      <li
        key={list.id}
        className="flex flex-col gap-2 rounded-control border border-line bg-surface p-3"
        data-testid="manage-list"
      >
        {renaming?.id === list.id ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = listNameSchema.safeParse(renaming.name);
              if (parsed.success) mutation.mutate({ kind: "rename", list, name: parsed.data });
              else announce(fieldMessage(parsed.error.issues[0]?.message));
            }}
          >
            <TextField
              label={t("listRenameLabel", { list: list.name })}
              value={renaming.name}
              ref={focusOnMount}
              onChange={(event) => {
                setRenaming({ id: list.id, name: event.target.value });
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
            <p className="text-body text-fg">
              <bdi className="font-medium">{list.name}</bdi>{" "}
              <span className="text-helper text-fg-muted">
                {t("listCounts", { open: list.openTasks, total: list.activeTasks })}
                {list.archived ? ` · ${t("archived")}` : ""}
              </span>
            </p>
            <div className="flex flex-wrap gap-1">
              {!list.archived ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === 0 || mutation.busy}
                    aria-label={t("listMoveUp", { list: list.name })}
                    onClick={() => {
                      move(list, -1);
                    }}
                  >
                    {t("moveUp")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === active.length - 1 || mutation.busy}
                    aria-label={t("listMoveDown", { list: list.name })}
                    onClick={() => {
                      move(list, 1);
                    }}
                  >
                    {t("moveDown")}
                  </Button>
                </>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("listRename", { list: list.name })}
                onClick={() => {
                  setRenaming({ id: list.id, name: list.name });
                }}
              >
                {t("rename")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.busy}
                aria-label={
                  list.archived
                    ? t("listUnarchive", { list: list.name })
                    : t("listArchive", { list: list.name })
                }
                onClick={() => {
                  mutation.mutate({ kind: "archive", list, archived: !list.archived });
                }}
              >
                {list.archived ? t("unarchive") : t("archive")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("listDelete", { list: list.name })}
                onClick={() => {
                  setDeleting(list);
                }}
                data-testid="manage-list-delete"
              >
                {t("delete")}
              </Button>
            </div>
          </>
        )}
      </li>
    );
  }

  return (
    <section aria-labelledby="manage-lists-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2
          id="manage-lists-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-section-title font-semibold text-fg outline-none"
        >
          {t("manageListsHeading")}
        </h2>
        <form
          className="flex flex-wrap items-end gap-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = listNameSchema.safeParse(name);
            if (!parsed.success) {
              setNameError(
                parsed.error.issues[0]?.message === "tooLong"
                  ? t("fieldTooLong")
                  : t("fieldRequired"),
              );
              return;
            }
            setNameError(null);
            mutation.mutate({ kind: "create", id: draftId, name: parsed.data });
          }}
        >
          <TextField
            ref={nameField}
            label={t("listNew")}
            value={name}
            error={nameError ?? undefined}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
            }}
            data-testid="list-new"
          />
          <Button type="submit" loading={mutation.busy}>
            {t("listCreate")}
          </Button>
        </form>
        {error ? (
          <FormAlert tone="error" announce>
            {texts.failure(error.failure, error.detail)}
          </FormAlert>
        ) : null}
        {active.length === 0 ? (
          <p className="text-body text-fg-muted">{t("manageNoLists")}</p>
        ) : (
          <ul className="flex flex-col gap-2">{active.map(row)}</ul>
        )}
        {archived.length > 0 ? (
          <>
            <h3 className="text-body font-semibold text-fg">
              {t("archivedLists", { count: archived.length })}
            </h3>
            <ul className="flex flex-col gap-2">{archived.map(row)}</ul>
          </>
        ) : null}
        <Dialog
          open={deleting !== null}
          onClose={() => {
            setDeleting(null);
          }}
          title={t("confirmDeleteListTitle")}
          description={
            deleting
              ? deleting.activeTasks > 0
                ? t("deleteListBlocked", { count: deleting.activeTasks })
                : t("confirmDeleteListBody", { list: isolate(deleting.name) })
              : ""
          }
          closeLabel={t("close")}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setDeleting(null);
                }}
              >
                {deleting && deleting.activeTasks > 0 ? t("close") : t("cancel")}
              </Button>
              {deleting && deleting.activeTasks === 0 ? (
                <Button
                  variant="destructive"
                  onClick={() => {
                    const list = deleting;
                    setDeleting(null);
                    mutation.mutate({ kind: "delete", list });
                  }}
                  data-testid="manage-list-confirm-delete"
                >
                  {t("delete")}
                </Button>
              ) : null}
            </>
          }
        />
      </HydrationGate>
    </section>
  );
}

type LabelChange =
  | {
      readonly kind: "create";
      readonly id: string;
      readonly name: string;
      readonly color: LabelColor | null;
    }
  | {
      readonly kind: "update";
      readonly label: TaskLabel;
      readonly name: string;
      readonly color: LabelColor | null;
    }
  | { readonly kind: "delete"; readonly label: TaskLabel };

/**
 * Managing a context's labels (S18): create, rename, recolour, and remove after an impact review
 * that says how many tasks carry the label (removal detaches it; tasks stay).
 */
export function ManageLabels({
  homeId,
  labels,
}: {
  readonly homeId: string | null;
  readonly labels: readonly TaskLabel[];
}) {
  const t = useTranslations("Tasks");
  const tAccent = useTranslations("Accent");
  const texts = useTaskTexts(noMembers);
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [editing, setEditing] = useState<{
    readonly id: string;
    readonly name: string;
    readonly color: string;
  } | null>(null);
  const [removing, setRemoving] = useState<TaskLabel | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { announce, region } = useAnnouncer();
  const fieldMessage = useFieldMessage();
  const colorOptions = [
    { value: "", label: t("labelColorNone") },
    ...labelColors.map((value) => ({ value, label: tAccent(value) })),
  ];
  const toColor = (value: string): LabelColor | null => (isLabelColor(value) ? value : null);

  const mutation = useTaskMutation(
    `task-labels:${homeId ?? "personal"}`,
    (change: LabelChange) => {
      switch (change.kind) {
        case "create":
          return sendTaskRequest("POST", TASK_LABELS_ENDPOINT, {
            id: change.id,
            homeId,
            name: change.name,
            color: change.color,
          });
        case "update":
          return sendTaskRequest("PATCH", `${TASK_LABELS_ENDPOINT}/${change.label.id}`, {
            expectedRevision: change.label.revision,
            name: change.name,
            color: change.color,
          });
        case "delete":
          return sendTaskRequest("DELETE", `${TASK_LABELS_ENDPOINT}/${change.label.id}`, {
            expectedRevision: change.label.revision,
          });
      }
    },
    (_result, change) => {
      if (change.kind === "create") {
        setName("");
        setColor("");
        setDraftId(crypto.randomUUID());
        announce(t("announceLabelCreated", { label: isolate(change.name) }));
      } else if (change.kind === "update") {
        setEditing(null);
        announce(t("announceLabelSaved"));
        headingRef.current?.focus();
      } else {
        announce(t("announceLabelDeleted", { label: isolate(change.label.name) }));
        headingRef.current?.focus();
      }
    },
  );
  const error = mutation.error instanceof TaskRequestError ? mutation.error : null;

  return (
    <section aria-labelledby="manage-labels-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2
          id="manage-labels-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-section-title font-semibold text-fg outline-none"
        >
          {t("manageLabelsHeading")}
        </h2>
        <form
          className="flex flex-wrap items-end gap-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = labelNameSchema.safeParse(name);
            if (!parsed.success) {
              setNameError(
                parsed.error.issues[0]?.message === "tooLong"
                  ? t("fieldTooLong")
                  : t("fieldRequired"),
              );
              return;
            }
            setNameError(null);
            mutation.mutate({
              kind: "create",
              id: draftId,
              name: parsed.data,
              color: toColor(color),
            });
          }}
        >
          <TextField
            label={t("labelNew")}
            value={name}
            error={nameError ?? undefined}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
            }}
            data-testid="label-new"
          />
          <SelectField
            label={t("labelColor")}
            value={color}
            options={colorOptions}
            onChange={(event) => {
              setColor(event.target.value);
            }}
          />
          <Button type="submit" loading={mutation.busy}>
            {t("labelCreate")}
          </Button>
        </form>
        {error ? (
          <FormAlert tone="error" announce>
            {texts.failure(error.failure, error.detail)}
          </FormAlert>
        ) : null}
        {labels.length === 0 ? (
          <p className="text-body text-fg-muted">{t("labelsNone")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {labels.map((label) => (
              <li
                key={label.id}
                className="flex flex-wrap items-center gap-2 rounded-control border border-line bg-surface p-3"
                data-testid="manage-label"
              >
                {editing?.id === label.id ? (
                  <form
                    className="flex flex-1 flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const parsed = labelNameSchema.safeParse(editing.name);
                      if (parsed.success) {
                        mutation.mutate({
                          kind: "update",
                          label,
                          name: parsed.data,
                          color: toColor(editing.color),
                        });
                      } else {
                        announce(fieldMessage(parsed.error.issues[0]?.message));
                      }
                    }}
                  >
                    <TextField
                      label={t("labelRenameLabel", { label: label.name })}
                      value={editing.name}
                      ref={focusOnMount}
                      onChange={(event) => {
                        setEditing({ ...editing, name: event.target.value });
                      }}
                    />
                    <SelectField
                      label={t("labelColor")}
                      value={editing.color}
                      options={colorOptions}
                      onChange={(event) => {
                        setEditing({ ...editing, color: event.target.value });
                      }}
                    />
                    <Button type="submit" size="sm" loading={mutation.busy}>
                      {t("save")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(null);
                        headingRef.current?.focus();
                      }}
                    >
                      {t("cancel")}
                    </Button>
                  </form>
                ) : (
                  <>
                    <LabelChip name={label.name} color={label.color} />
                    <span className="text-helper text-fg-muted">
                      {t("labelUsage", { count: label.taskCount })}
                    </span>
                    <span className="ms-auto flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("labelEdit", { label: label.name })}
                        onClick={() => {
                          setEditing({ id: label.id, name: label.name, color: label.color ?? "" });
                        }}
                      >
                        {t("edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("labelRemove", { label: label.name })}
                        onClick={() => {
                          setRemoving(label);
                        }}
                      >
                        {t("remove")}
                      </Button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <Dialog
          open={removing !== null}
          onClose={() => {
            setRemoving(null);
          }}
          title={t("confirmRemoveLabelTitle")}
          description={
            removing
              ? t("confirmRemoveLabelBody", {
                  label: isolate(removing.name),
                  count: removing.taskCount,
                })
              : ""
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
                  const label = removing;
                  setRemoving(null);
                  if (label) mutation.mutate({ kind: "delete", label });
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
