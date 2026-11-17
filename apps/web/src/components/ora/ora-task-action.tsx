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
  applyChangeDue,
  applyCompleteTask,
  fetchTaskChoices,
  fetchTaskEdit,
  undoCompletion,
  undoDue,
  type ApplyFailure,
} from "@/ora/actions/client";
import { newDraft, type ActionDraft } from "@/ora/actions/draft";
import { UNDO_WINDOW_MS, type OraTaskEditActionId, type UndoResult } from "@/ora/actions/types";
import { recordHistory } from "@/ora/history/client";
import type { HistoryKind } from "@/ora/history/types";
import { OraToolError } from "@/ora/tools/client";

import type { OraStatus } from "./ora-content";

export interface OraTaskActionProps {
  readonly action: OraTaskEditActionId;
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

interface BodyProps extends OraTaskActionProps {
  readonly focusView: (selector?: string) => void;
}

/** What Undo needs to put things back; absent when the change was not Ora's (already completed). */
type UndoTarget =
  | { readonly kind: "completion"; readonly id: string; readonly completedAt: string }
  | {
      readonly kind: "due";
      readonly id: string;
      readonly previousDue: string | null;
      readonly revision: number;
    };

type Phase =
  | { readonly kind: "editing" }
  | { readonly kind: "saving" }
  | { readonly kind: "failed"; readonly failure: ApplyFailure }
  | {
      readonly kind: "done";
      readonly title: string;
      readonly alreadyDone: boolean;
      readonly undoTarget: UndoTarget | null;
      readonly undo: "available" | "working" | UndoResult | "failed";
    };

const failureKey = {
  signedOut: "failSignedOut",
  "not-permitted": "failNotPermitted",
  duplicate: "failGeneric",
  "list-unavailable": "failGone",
  invalid: "failInvalid",
  conflict: "failChanged",
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
 * A guided edit of an existing task (S47d): complete it, or change its due date. The person picks
 * one of their open tasks, sees exactly what will happen, and confirms; the change goes through the
 * task module's own API (which checks permissions and the task's revision again) and a short Undo
 * puts it back only if nobody touched the task meanwhile.
 */
function OraTaskActionBody({
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
  const t = useTranslations("OraTaskAction");
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

  const isComplete = action === "complete-task";
  const undoneKey = isComplete ? "undoneComplete" : "undoneDue";
  const place = homeId ?? "personal";

  const choices = useQuery({
    queryKey: ["ora", "task-action", userId, place, action],
    queryFn: () => fetchTaskChoices(homeId, action),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const tasks = choices.data ?? [];
  const picked = tasks.find((task) => task.id === draft.taskId);
  const taskId = picked?.id ?? "";

  // A due-date change saves the whole task as it is now but for the date, so it needs the task.
  const detail = useQuery({
    queryKey: ["ora", "task-edit", userId, place, taskId],
    queryFn: () => fetchTaskEdit(homeId, taskId),
    enabled: !isComplete && taskId !== "",
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const task = detail.data ?? null;

  useEffect(() => {
    onStatus(
      choices.isFetching || detail.isFetching || phase.kind === "saving" ? "working" : "idle",
    );
  }, [choices.isFetching, detail.isFetching, phase.kind, onStatus]);
  useEffect(
    () => () => {
      onStatus("idle");
    },
    [onStatus],
  );

  const moduleHref = homeId === null ? "/tasks" : `/homes/${homeId}/tasks`;

  function update(patch: Partial<ActionDraft>) {
    setFieldError(null);
    if (phase.kind === "failed") setPhase({ kind: "editing" });
    onDraft({ ...draft, ...patch });
  }

  function logHistory(kind: HistoryKind, label: string) {
    void recordHistory({ homeId, kind, label })
      .then(() => queryClient.invalidateQueries({ queryKey: ["ora", "history", userId] }))
      .catch(() => undefined);
  }

  async function confirm() {
    if (picked === undefined) {
      setFieldError(t("errorPick"));
      focusView("select");
      return;
    }
    const title = picked.title;
    setFieldError(null);
    try {
      if (isComplete) {
        setPhase({ kind: "saving" });
        const completed = await applyCompleteTask(picked.id);
        onDraft(undefined);
        if (completed.completedAt !== null) logHistory("task-completed", title);
        finish(
          title,
          completed.completedAt === null
            ? null
            : { kind: "completion", id: picked.id, completedAt: completed.completedAt },
        );
        return;
      }
      if (task === null) {
        setFieldError(t("failGone"));
        return;
      }
      if (!draft.clearDue && draft.due === "") {
        setFieldError(t("errorDue"));
        focusView("input");
        return;
      }
      if (!draft.clearDue && task.startDate !== null && draft.due < task.startDate) {
        setFieldError(t("errorBeforeStart", { start: task.startDate }));
        focusView("input");
        return;
      }
      setPhase({ kind: "saving" });
      const changed = await applyChangeDue(task, draft.clearDue ? null : draft.due);
      onDraft(undefined);
      logHistory("task-due-changed", title);
      finish(title, { kind: "due", ...changed });
    } catch (error) {
      if (error instanceof ApplyError) {
        // What Ora showed may be out of date: look at the task and the list again.
        if (error.failure !== "network" && error.failure !== "signedOut") {
          void choices.refetch();
          void detail.refetch();
        }
        setPhase({ kind: "failed", failure: error.failure });
      } else {
        setPhase({ kind: "failed", failure: "failed" });
      }
    }
  }

  function finish(title: string, undoTarget: UndoTarget | null) {
    setPhase({
      kind: "done",
      title,
      alreadyDone: undoTarget === null,
      undoTarget,
      undo: undoTarget === null ? "expired" : "available",
    });
    if (undoTarget !== null && !activeRef.current) announceWithUndo(title, undoTarget);
    void queryClient.invalidateQueries({ queryKey: ["ora", "task-action", userId] });
  }

  async function runUndo(title: string, target: UndoTarget): Promise<UndoResult | "failed"> {
    try {
      const result =
        target.kind === "completion"
          ? await undoCompletion(homeId, target)
          : await undoDue(homeId, target);
      if (result === "undone") {
        logHistory(
          target.kind === "completion" ? "task-completion-undone" : "task-due-restored",
          title,
        );
        void queryClient.invalidateQueries({ queryKey: ["ora", "task-action", userId] });
      }
      return result;
    } catch (error) {
      return error instanceof OraToolError && error.failure === "forbidden"
        ? "not-permitted"
        : "failed";
    }
  }

  function announceWithUndo(title: string, target: UndoTarget) {
    toast.show({
      title: t(isComplete ? "doneComplete" : "doneDue", { title }),
      tone: "success",
      duration: UNDO_WINDOW_MS,
      action: {
        label: t("undo"),
        onAction: () => {
          void runUndo(title, target).then((result) => {
            toast.show({
              title: t(result === "undone" ? undoneKey : undoMessageKey[result]),
              tone: result === "undone" ? "success" : "warning",
            });
          });
        },
      },
    });
  }

  // The Undo button goes away when its window ends, as a shortcut only.
  const doneTitle = phase.kind === "done" ? phase.title : null;
  useEffect(() => {
    if (doneTitle === null) return;
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
  }, [doneTitle]);

  const phaseKind = phase.kind;
  useEffect(() => {
    if (phaseKind === "done" || phaseKind === "failed") focusView();
  }, [phaseKind, focusView]);

  if (choices.isPending) {
    return (
      <p role="status" className="text-helper text-fg-muted">
        {t("loading")}
      </p>
    );
  }

  if (choices.isError) {
    return (
      <div role="status" className="flex flex-col gap-3" data-testid="ora-task-action-unavailable">
        <p className="text-helper">{t("unavailable")}</p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void choices.refetch()}>
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
        : phase.alreadyDone
          ? t("alreadyDone", { title: phase.title })
          : t(phase.undo === "undone" ? undoneKey : undoMessageKey[phase.undo]);
    const target = phase.undoTarget;
    return (
      <div className="flex flex-col gap-3" data-testid="ora-task-action-done">
        <p role="status" className="text-body">
          {undoNote ?? t(isComplete ? "doneComplete" : "doneDue", { title: phase.title })}
        </p>
        <div className="flex flex-wrap gap-2">
          {target !== null && (phase.undo === "available" || phase.undo === "working") ? (
            <Button
              variant="secondary"
              size="sm"
              loading={phase.undo === "working"}
              onClick={() => {
                const done = phase;
                setPhase({ ...done, undo: "working" });
                void runUndo(done.title, target).then((result) => {
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
              {t("openTasks")}
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

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col gap-3" data-testid="ora-task-action-nothing">
        <h3 className="text-body font-semibold">{t(isComplete ? "titleComplete" : "titleDue")}</h3>
        <p className="text-helper">{t("noTasks")}</p>
        <div className="flex gap-2">
          <Link
            href={moduleHref}
            onClick={onNavigated}
            className="inline-flex min-h-8 items-center rounded-control border border-line-control px-3 text-helper text-fg hover:bg-accent-subtle"
          >
            {t("openTasks")}
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
  const taskGone = !isComplete && picked !== undefined && detail.isSuccess && task === null;
  const loadingTask = !isComplete && picked !== undefined && detail.isFetching && task === null;
  const newDue = draft.clearDue ? "" : draft.due;
  let summary = t("summaryNone");
  if (picked !== undefined) {
    if (isComplete) summary = t("summaryComplete", { title: picked.title });
    else if (task !== null && (draft.clearDue || newDue !== "")) {
      summary = draft.clearDue
        ? t("summaryDueClear", { title: task.title })
        : t("summaryDue", {
            title: task.title,
            to: newDue,
            hasOld: task.dueDate === null ? "no" : "yes",
            from: task.dueDate ?? "",
          });
    }
  }
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="ora-task-action-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void confirm();
      }}
    >
      <h3 className="text-body font-semibold">{t(isComplete ? "titleComplete" : "titleDue")}</h3>
      <p className="text-helper text-fg-muted">{t("lead", { context: contextName })}</p>
      <SelectField
        label={t("fieldTask")}
        value={taskId}
        onChange={(event) => {
          update({ taskId: event.target.value, due: "", clearDue: false });
        }}
        error={picked === undefined ? (fieldError ?? undefined) : undefined}
        options={[
          { value: "", label: t("pickTask") },
          ...tasks.map((choice) => ({
            value: choice.id,
            label: t("taskOption", {
              title: choice.title,
              list: choice.listName,
              hasDue: choice.dueDate === null ? "no" : "yes",
              due: choice.dueDate ?? "",
            }),
          })),
        ]}
      />
      {!isComplete && picked !== undefined && task !== null ? (
        <>
          <TextField
            label={t("fieldDue")}
            type="date"
            value={newDue}
            disabled={draft.clearDue}
            onChange={(event) => {
              update({ due: event.target.value });
            }}
            error={fieldError ?? undefined}
          />
          {task.dueDate !== null ? (
            <label className="flex cursor-pointer items-center gap-3 text-helper">
              <input
                type="checkbox"
                checked={draft.clearDue}
                onChange={(event) => {
                  update({ clearDue: event.target.checked, due: "" });
                }}
                className="size-5 shrink-0 cursor-pointer accent-accent"
              />
              {t("clearDue")}
            </label>
          ) : null}
        </>
      ) : null}
      {loadingTask ? (
        <p role="status" className="text-helper text-fg-muted">
          {t("loading")}
        </p>
      ) : null}
      {taskGone ? (
        <p role="alert" className="text-helper text-danger">
          {t("failGone")}
        </p>
      ) : null}

      <p
        className="rounded-control bg-accent-subtle p-3 text-helper"
        data-testid="ora-task-action-summary"
      >
        {summary}
      </p>

      {failure ? (
        <p role="alert" className="text-helper text-danger">
          {t(failureKey[failure])}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          loading={saving}
          disabled={picked === undefined || (!isComplete && task === null)}
        >
          {t(isComplete ? "confirmComplete" : "confirmDue")}
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

/** One guided task edit; the wrapper receives focus whenever the view behind a pressed control changes. */
export function OraTaskAction(props: OraTaskActionProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const focusView = useCallback((selector?: string) => {
    const target = selector ? wrapper.current?.querySelector<HTMLElement>(selector) : null;
    (target ?? wrapper.current)?.focus();
  }, []);
  useEffect(() => {
    focusView();
  }, [focusView]);
  return (
    <div ref={wrapper} tabIndex={-1} className="outline-none" data-testid="ora-task-action">
      <OraTaskActionBody {...props} focusView={focusView} />
    </div>
  );
}
