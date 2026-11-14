"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useToast } from "@/components/ui/toast";
import {
  ApplyError,
  applyAddShoppingItem,
  applyAddTask,
  prepareAction,
  undoAction,
  type Applied,
  type ApplyFailure,
} from "@/ora/actions/client";
import { newDraft, type ActionDraft } from "@/ora/actions/draft";
import { UNDO_WINDOW_MS, type OraActionId, type UndoResult } from "@/ora/actions/types";
import { recordHistory } from "@/ora/history/client";
import type { HistoryKind } from "@/ora/history/types";
import { rememberList } from "@/ora/memories/client";
import { OraToolError } from "@/ora/tools/client";
import { itemNameSchema } from "@/shopping/schema";
import { taskTitleSchema } from "@/tasks/schema";

import type { OraStatus } from "./ora-content";

export interface OraActionProps {
  readonly action: OraActionId;
  readonly userId: string;
  readonly homeId: string | null;
  readonly contextName: string;
  /** Whether Ora's surface is open; when it is closed a result is announced as a toast with Undo. */
  readonly active: boolean;
  readonly draft: ActionDraft | undefined;
  readonly onDraft: (draft: ActionDraft | undefined) => void;
  readonly onBack: () => void;
  readonly onNavigated: () => void;
  readonly onStatus: (status: OraStatus) => void;
}

interface BodyProps extends OraActionProps {
  /** Moves focus into this view when what is shown changes (the pressed control is gone). */
  readonly focusView: (selector?: string) => void;
}

type Phase =
  | { readonly kind: "editing" }
  | { readonly kind: "saving" }
  | { readonly kind: "failed"; readonly failure: ApplyFailure }
  | {
      readonly kind: "done";
      readonly applied: Applied;
      readonly listId: string;
      readonly label: string;
      readonly listName: string;
      /** Whether Ora was asked to remember the list: saved, or the save did not go through. */
      readonly remembered: "saved" | "failed" | null;
      readonly undo: "available" | "working" | UndoResult | "failed";
    };

const failureKey = {
  signedOut: "failSignedOut",
  "not-permitted": "failNotPermitted",
  duplicate: "failDuplicate",
  "list-unavailable": "failListUnavailable",
  invalid: "failInvalid",
  network: "failNetwork",
  failed: "failGeneric",
} as const satisfies Record<ApplyFailure, string>;

const undoMessageKey = {
  undone: "undone",
  changed: "undoChanged",
  gone: "undoGone",
  expired: "undoExpired",
  "not-permitted": "undoNotPermitted",
  failed: "undoFailed",
} as const;

/**
 * One guided change (S47): an editable preview inside Ora, a confirm button named for the change, a
 * result that says what happened, and a short Undo for the safe reversal. Nothing changes until the
 * person presses the confirm button; the change goes through the module's own API (which checks the
 * person's permissions again) and a failure keeps everything typed so it can be retried.
 */
function OraActionBody({
  action,
  userId,
  homeId,
  contextName,
  active,
  draft: storedDraft,
  onDraft,
  onBack,
  onNavigated,
  onStatus,
  focusView,
}: BodyProps) {
  const t = useTranslations("OraAction");
  const toast = useToast();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [initial] = useState(() => storedDraft ?? newDraft());
  const draft = storedDraft ?? initial;
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const preview = useQuery({
    queryKey: ["ora", "action", userId, homeId ?? "personal", action],
    queryFn: () => prepareAction(homeId, action),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const destinations = preview.data?.destinations ?? [];
  const remembered = preview.data?.remembered ?? null;
  // The person's own pick wins, then the list they asked Ora to remember (still usable, the server
  // checked), then the first list. It is only a preselection: the preview shows it and they confirm.
  const listId = destinations.some((destination) => destination.id === draft.listId)
    ? draft.listId
    : (remembered ?? destinations[0]?.id ?? "");
  const listName = destinations.find((destination) => destination.id === listId)?.name ?? "";

  useEffect(() => {
    onStatus(preview.isFetching || phase.kind === "saving" ? "working" : "idle");
  }, [preview.isFetching, phase.kind, onStatus]);
  // Leaving the view leaves nothing "working" behind.
  useEffect(
    () => () => {
      onStatus("idle");
    },
    [onStatus],
  );

  const isTask = action === "add-task";
  const modulePath = isTask ? "tasks" : "shopping";
  const moduleHref =
    homeId === null ? (isTask ? "/tasks" : "/shopping") : `/homes/${homeId}/${modulePath}`;

  function update(patch: Partial<ActionDraft>) {
    setFieldError(null);
    // Editing after a failure keeps the preview; editing after a duplicate warning asks again.
    if (phase.kind === "failed") setPhase({ kind: "editing" });
    onDraft({ ...draft, ...patch });
  }

  // One line in Ora's seven-day history; a courtesy, so a failure is not shown.
  function logHistory(kind: HistoryKind, label: string) {
    void recordHistory({ homeId, kind, label })
      .then(() => queryClient.invalidateQueries({ queryKey: ["ora", "history", userId] }))
      .catch(() => undefined);
  }

  async function confirm() {
    const parsed = (isTask ? taskTitleSchema : itemNameSchema).safeParse(draft.text);
    if (!parsed.success) {
      setFieldError(draft.text.trim() === "" ? t("errorRequired") : t("errorTooLong"));
      focusView("input");
      return;
    }
    const label: string = parsed.data;
    setFieldError(null);
    setPhase({ kind: "saving" });
    try {
      const applied = isTask
        ? await applyAddTask({
            id: draft.recordId,
            homeId,
            listId,
            title: label,
            dueDate: draft.due === "" ? null : draft.due,
          })
        : await applyAddShoppingItem({
            id: draft.recordId,
            listId,
            name: label,
            allowDuplicate: draft.allowDuplicate,
          });
      onDraft(undefined);
      logHistory(isTask ? "task-added" : "shopping-item-added", label);
      let memory: "saved" | "failed" | null = null;
      if (draft.remember && listId !== remembered) {
        memory = await rememberList({ homeId, action, listId })
          .then(() => "saved" as const)
          .catch(() => "failed" as const);
        if (memory === "saved") {
          await queryClient.invalidateQueries({ queryKey: ["ora", "action", userId] });
        }
      }
      setPhase({
        kind: "done",
        applied,
        listId,
        label,
        listName,
        remembered: memory,
        undo: "available",
      });
      if (!activeRef.current) announceWithUndo(applied, listId, label, listName);
    } catch (error) {
      if (error instanceof ApplyError) {
        if (error.failure === "not-permitted" || error.failure === "list-unavailable") {
          // What Ora offered may have changed: look again.
          void preview.refetch();
        }
        setPhase({ kind: "failed", failure: error.failure });
      } else {
        setPhase({ kind: "failed", failure: "failed" });
      }
    }
  }

  async function runUndo(
    applied: Applied,
    forList: string,
    label: string,
  ): Promise<UndoResult | "failed"> {
    try {
      const result = await undoAction(homeId, action, {
        ...applied,
        ...(isTask ? {} : { listId: forList }),
      });
      if (result === "undone") {
        logHistory(isTask ? "task-undone" : "shopping-item-undone", label);
      }
      return result;
    } catch (error) {
      return error instanceof OraToolError && error.failure === "forbidden"
        ? "not-permitted"
        : "failed";
    }
  }

  function announceWithUndo(applied: Applied, forList: string, label: string, forListName: string) {
    toast.show({
      title: t(isTask ? "doneTask" : "doneItem", { name: label, list: forListName }),
      tone: "success",
      duration: UNDO_WINDOW_MS,
      action: {
        label: t("undo"),
        onAction: () => {
          void runUndo(applied, forList, label).then((result) => {
            toast.show({
              title: t(result === "undone" ? "undone" : undoMessageKey[result]),
              tone: result === "undone" ? "success" : "warning",
            });
          });
        },
      },
    });
  }

  // The Undo button goes away when its window ends, as a shortcut only: the record keeps its own page.
  const doneAt = phase.kind === "done" ? phase.applied.id : null;
  useEffect(() => {
    if (doneAt === null) return;
    const timer = window.setTimeout(() => {
      setPhase((current) =>
        current.kind === "done" && current.undo === "available"
          ? { ...current, undo: "expired" }
          : current,
      );
    }, UNDO_WINDOW_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [doneAt]);

  // When the form is replaced by the result (or the failure notice), focus follows to the new view.
  const phaseKind = phase.kind;
  useEffect(() => {
    if (phaseKind === "done" || phaseKind === "failed") focusView();
  }, [phaseKind, focusView]);

  if (preview.isPending) {
    return (
      <p role="status" className="text-helper text-fg-muted">
        {t("loading")}
      </p>
    );
  }

  if (preview.isError) {
    return (
      <div role="status" className="flex flex-col gap-3" data-testid="ora-action-unavailable">
        <p className="text-helper">{t("unavailable")}</p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void preview.refetch()}>
            {t("retry")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onBack}>
            {t("back")}
          </Button>
        </div>
      </div>
    );
  }

  if (phase.kind === "done") {
    const undoNote =
      phase.undo === "available" || phase.undo === "working"
        ? null
        : t(phase.undo === "undone" ? "undone" : undoMessageKey[phase.undo]);
    return (
      <div className="flex flex-col gap-3" data-testid="ora-action-done">
        <p role="status" className="text-body">
          {undoNote ??
            t(isTask ? "doneTask" : "doneItem", { name: phase.label, list: phase.listName })}
        </p>
        {phase.remembered ? (
          <p role="status" className="text-helper text-fg-muted">
            {t(phase.remembered === "saved" ? "rememberedSaved" : "rememberedFailed", {
              list: phase.listName,
            })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {phase.undo === "available" || phase.undo === "working" ? (
            <Button
              variant="secondary"
              size="sm"
              loading={phase.undo === "working"}
              onClick={() => {
                const done = phase;
                setPhase({ ...done, undo: "working" });
                void runUndo(done.applied, done.listId, done.label).then((result) => {
                  setPhase({ ...done, undo: result });
                });
              }}
            >
              {t("undo")}
            </Button>
          ) : (
            <Link
              href={moduleHref}
              onClick={onNavigated}
              className="inline-flex min-h-8 items-center rounded-control border border-line-control px-3 text-helper text-fg hover:bg-accent-subtle"
            >
              {t(isTask ? "openTasks" : "openShopping")}
            </Link>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPhase({ kind: "editing" });
              onDraft(newDraft());
            }}
          >
            {t("another")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onBack}>
            {t("back")}
          </Button>
        </div>
      </div>
    );
  }

  if (destinations.length === 0) {
    return (
      <div className="flex flex-col gap-3" data-testid="ora-action-nowhere">
        <h3 className="text-body font-semibold">{t(isTask ? "titleTask" : "titleItem")}</h3>
        <p className="text-helper">{t(isTask ? "noTaskList" : "noShoppingList")}</p>
        <div className="flex gap-2">
          <Link
            href={moduleHref}
            onClick={onNavigated}
            className="inline-flex min-h-8 items-center rounded-control border border-line-control px-3 text-helper text-fg hover:bg-accent-subtle"
          >
            {t(isTask ? "openTasks" : "openShopping")}
          </Link>
          <Button variant="ghost" size="sm" onClick={onBack}>
            {t("back")}
          </Button>
        </div>
      </div>
    );
  }

  const failure = phase.kind === "failed" ? phase.failure : null;
  const saving = phase.kind === "saving";
  const trimmed = draft.text.trim();
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="ora-action-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void confirm();
      }}
    >
      <h3 className="text-body font-semibold">{t(isTask ? "titleTask" : "titleItem")}</h3>
      <p className="text-helper text-fg-muted">{t("lead", { context: contextName })}</p>
      <TextField
        label={t(isTask ? "fieldTask" : "fieldItem")}
        value={draft.text}
        onChange={(event) => {
          update({ text: event.target.value });
        }}
        error={fieldError ?? undefined}
        autoComplete="off"
        required
      />
      {isTask ? (
        <TextField
          label={t("fieldDue")}
          type="date"
          value={draft.due}
          onChange={(event) => {
            update({ due: event.target.value });
          }}
        />
      ) : null}
      {destinations.length > 1 ? (
        <SelectField
          label={t(isTask ? "fieldTaskList" : "fieldShoppingList")}
          value={listId}
          onChange={(event) => {
            update({ listId: event.target.value, allowDuplicate: false });
          }}
          options={destinations.map((destination) => ({
            value: destination.id,
            label: destination.name,
          }))}
        />
      ) : null}

      {destinations.length > 1 ? (
        <>
          {remembered !== null && remembered === listId ? (
            <p className="text-helper text-fg-muted" data-testid="ora-action-remembered">
              {t("rememberedUsed")}
            </p>
          ) : null}
          {listId !== remembered ? (
            <label className="flex cursor-pointer items-center gap-3 text-helper">
              <input
                type="checkbox"
                checked={draft.remember}
                onChange={(event) => {
                  update({ remember: event.target.checked });
                }}
                className="size-5 shrink-0 cursor-pointer accent-accent"
              />
              {t("rememberOption", { list: listName })}
            </label>
          ) : null}
        </>
      ) : null}

      <p
        className="rounded-control bg-accent-subtle p-3 text-helper"
        data-testid="ora-action-summary"
      >
        {trimmed === ""
          ? t("summaryEmpty")
          : t(isTask ? "summaryTask" : "summaryItem", {
              name: trimmed,
              list: listName,
              context: contextName,
              hasDue: draft.due === "" ? "no" : "yes",
              due: draft.due,
            })}
      </p>

      {failure ? (
        <div role="alert" className="flex flex-col gap-2 text-helper text-danger">
          <p>{t(failureKey[failure])}</p>
          {failure === "duplicate" ? (
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  update({ allowDuplicate: true });
                }}
              >
                {t("addAnyway")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={saving}>
          {t(isTask ? "confirmTask" : "confirmItem")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => {
            onDraft(undefined);
            onBack();
          }}
        >
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

/** One guided change; the wrapper receives focus whenever the view behind a pressed control changes. */
export function OraAction(props: OraActionProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const focusView = useCallback((selector?: string) => {
    const target = selector ? wrapper.current?.querySelector<HTMLElement>(selector) : null;
    (target ?? wrapper.current)?.focus();
  }, []);
  useEffect(() => {
    focusView();
  }, [focusView]);
  return (
    <div ref={wrapper} tabIndex={-1} className="outline-none" data-testid="ora-action">
      <OraActionBody {...props} focusView={focusView} />
    </div>
  );
}
