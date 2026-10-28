"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import {
  BULK_ENDPOINT,
  sendTaskRequest,
  type TaskRequestError,
  type BulkOutcome,
  type BulkResponse,
  type BulkResult,
  type TaskRow,
} from "@/tasks/api";
import { noMembers } from "@/tasks/format";
import {
  bulkActions,
  labelModes,
  TASK_LIMITS,
  taskPriorities,
  type BulkAction,
  type BulkInput,
  type LabelMode,
  type TaskPriority,
} from "@/tasks/schema";

import { LabelPicker, type LabelOption } from "./label-picker";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

/** The chosen action and its value, before the tasks and revisions are added. */
export type BulkChoice =
  | { readonly action: "complete" }
  | { readonly action: "priority"; readonly priority: TaskPriority | null }
  | {
      readonly action: "labels";
      readonly labelMode: LabelMode;
      readonly labelIds: readonly string[];
    }
  | { readonly action: "move"; readonly listId: string };

function sendBulk(
  homeId: string | null,
  taskIds: readonly string[],
  choice: BulkChoice,
  expectedRevisions: Readonly<Record<string, number>> | null,
  dryRun: boolean,
): Promise<BulkResponse> {
  const base = {
    homeId,
    taskIds: [...taskIds],
    expectedRevisions: expectedRevisions ? { ...expectedRevisions } : null,
    dryRun,
  };
  const body: BulkInput =
    choice.action === "labels"
      ? { ...base, action: "labels", labelMode: choice.labelMode, labelIds: [...choice.labelIds] }
      : { ...base, ...choice };
  return sendTaskRequest<BulkResponse>("POST", BULK_ENDPOINT, body);
}

const actionKey = {
  complete: "actionComplete",
  priority: "actionPriority",
  labels: "actionLabels",
  move: "actionMove",
} as const satisfies Record<BulkAction, string>;

const modeKey = {
  add: "labelsAdd",
  remove: "labelsRemove",
  replace: "labelsReplace",
} as const satisfies Record<LabelMode, string>;

/** Why a task is left out, in words. */
const reasonKey = {
  changed: "reasonChanged",
  will_change: "reasonWillChange",
  unchanged: "reasonUnchanged",
  conflict: "reasonConflict",
  not_found: "reasonNotFound",
  not_permitted: "reasonNotPermitted",
  list_unavailable: "reasonListUnavailable",
  invalid_label: "reasonInvalidLabel",
  too_many_labels: "reasonTooManyLabels",
  failed: "reasonFailed",
} as const satisfies Record<BulkOutcome, string>;

export interface BulkBarProps {
  readonly homeId: string | null;
  /** The rows currently shown, in order. */
  readonly shown: readonly TaskRow[];
  readonly selected: ReadonlySet<string>;
  readonly onSelect: (ids: ReadonlySet<string>) => void;
  readonly onDone: () => void;
  readonly labels: readonly LabelOption[];
  /** Active lists of this context, for Move. */
  readonly lists: readonly { readonly id: string; readonly name: string }[];
}

/**
 * The bar of the select mode (S19b; spec "basic bulk task actions"): how many are selected, select
 * all shown, clear, and the action with its value. Review asks the server what would happen to
 * each selected task before anything changes.
 */
export function BulkBar({
  homeId,
  shown,
  selected,
  onSelect,
  onDone,
  labels,
  lists,
}: BulkBarProps) {
  const t = useTranslations("TaskBulk");
  const texts = useTaskTexts(noMembers);
  const modeName = useId();
  const [action, setAction] = useState<BulkAction>("complete");
  const [priority, setPriority] = useState<TaskPriority | "">("");
  const [labelMode, setLabelMode] = useState<LabelMode>("add");
  const [labelIds, setLabelIds] = useState<readonly string[]>([]);
  const [listId, setListId] = useState(lists[0]?.id ?? "");
  const [reviewing, setReviewing] = useState<BulkChoice | null>(null);
  const shownIds = shown.map((row) => row.id);
  const allShown = shownIds.slice(0, TASK_LIMITS.bulk);

  const choice: BulkChoice | null =
    action === "complete"
      ? { action }
      : action === "priority"
        ? { action, priority: priority === "" ? null : priority }
        : action === "labels"
          ? labelIds.length > 0 || labelMode === "replace"
            ? { action, labelMode, labelIds }
            : null
          : listId
            ? { action, listId }
            : null;

  return (
    <div
      className="flex flex-col gap-3 rounded-card border border-accent-edge bg-accent-subtle p-4"
      role="region"
      aria-label={t("barLabel")}
      data-testid="bulk-bar"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-body font-medium text-fg" aria-live="polite" data-testid="bulk-count">
          {t("selectedCount", { count: selected.size })}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onSelect(new Set(allShown));
          }}
          disabled={shown.length === 0}
        >
          {t("selectAllShown", { count: allShown.length })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onSelect(new Set());
          }}
          disabled={selected.size === 0}
        >
          {t("clear")}
        </Button>
      </div>
      {shown.length > TASK_LIMITS.bulk ? (
        <p className="text-helper text-fg-muted">{t("limit", { max: TASK_LIMITS.bulk })}</p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label={t("action")}
          options={bulkActions.map((value) => ({ value, label: t(actionKey[value]) }))}
          value={action}
          onChange={(event) => {
            setAction(event.target.value as BulkAction);
          }}
        />
        {action === "priority" ? (
          <SelectField
            label={t("newPriority")}
            options={[
              { value: "", label: texts.priority(null) },
              ...taskPriorities.map((value) => ({ value, label: texts.priority(value) })),
            ]}
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value as TaskPriority | "");
            }}
          />
        ) : null}
        {action === "move" ? (
          <SelectField
            label={t("targetList")}
            options={lists.map((list) => ({ value: list.id, label: list.name }))}
            value={listId}
            onChange={(event) => {
              setListId(event.target.value);
            }}
          />
        ) : null}
      </div>
      {action === "labels" ? (
        <>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-body font-medium text-fg">{t("labelsLegend")}</legend>
            {labelModes.map((mode) => (
              <RadioOption
                key={mode}
                name={modeName}
                value={mode}
                label={t(modeKey[mode])}
                checked={labelMode === mode}
                onChange={() => {
                  setLabelMode(mode);
                }}
              />
            ))}
          </fieldset>
          <LabelPicker labels={labels} value={labelIds} onChange={setLabelIds} />
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={selected.size === 0 || choice === null}
          onClick={() => {
            if (choice) setReviewing(choice);
          }}
          data-testid="bulk-review"
        >
          {t("review", { count: selected.size })}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t("exit")}
        </Button>
      </div>
      {reviewing ? (
        <BulkDialog
          homeId={homeId}
          taskIds={[...selected]}
          titles={new Map(shown.map((row) => [row.id, row.title]))}
          choice={reviewing}
          onClose={(applied) => {
            setReviewing(null);
            if (applied) onSelect(new Set());
          }}
        />
      ) : null}
    </div>
  );
}

interface BulkDialogProps {
  readonly homeId: string | null;
  readonly taskIds: readonly string[];
  readonly titles: ReadonlyMap<string, string>;
  readonly choice: BulkChoice;
  readonly onClose: (applied: boolean) => void;
}

/**
 * Previews a bulk action from the server's dry run (what changes, what is already so, what is left
 * out and why, with the warnings), applies it with each task's previewed revision, then shows each
 * task's result. A partial result is never called complete.
 *
 * The tasks are the ones selected when Review was opened. The open list drops rows that just
 * completed, and the selection follows the rows still shown, so it can become empty while this
 * dialog is open. Starting the preview again from that empty selection is not a preview: the
 * server rejects it, and the browser reports the rejection as a console error.
 */
function BulkDialog({ homeId, taskIds, titles, choice, onClose }: BulkDialogProps) {
  const t = useTranslations("TaskBulk");
  const tTasks = useTranslations("Tasks");
  const texts = useTaskTexts(noMembers);
  const [reviewed] = useState(() => ({
    taskIds: [...taskIds],
    titles: new Map(titles),
    choice,
  }));
  const [result, setResult] = useState<BulkResponse | null>(null);
  const preview = useQuery<BulkResponse, TaskRequestError>({
    queryKey: ["task-bulk-preview", homeId, reviewed.taskIds, reviewed.choice],
    queryFn: () => sendBulk(homeId, reviewed.taskIds, reviewed.choice, null, true),
    enabled: reviewed.taskIds.length > 0 && result === null,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const apply = useTaskMutation(
    `task-bulk:${homeId ?? "personal"}`,
    (revisions: Readonly<Record<string, number>>) =>
      sendBulk(homeId, reviewed.taskIds, reviewed.choice, revisions, false),
    (response) => {
      setResult(response);
    },
  );
  const rows = result?.results ?? preview.data?.results ?? [];
  const willChange = rows.filter((row) => row.outcome === "will_change");

  function confirm() {
    if (!preview.data) return;
    const revisions: Record<string, number> = {};
    for (const row of preview.data.results) {
      if (row.revision !== null) revisions[row.taskId] = row.revision;
    }
    apply.mutate(revisions);
  }

  return (
    <Dialog
      open
      onClose={() => {
        onClose(result !== null);
      }}
      title={
        result
          ? t("resultTitle")
          : t("previewTitle", { action: t(actionKey[reviewed.choice.action]) })
      }
      closeLabel={tTasks("close")}
      footer={
        result ? (
          <Button
            onClick={() => {
              onClose(true);
            }}
            data-testid="bulk-done"
          >
            {t("done")}
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              onClick={() => {
                onClose(false);
              }}
              disabled={apply.busy}
            >
              {tTasks("cancel")}
            </Button>
            <Button
              loading={apply.busy}
              disabled={preview.isPending || preview.isError || willChange.length === 0}
              onClick={confirm}
              data-testid="bulk-apply"
            >
              {t("apply", { count: willChange.length })}
            </Button>
          </>
        )
      }
    >
      <div
        aria-live="polite"
        aria-busy={!result && preview.isPending}
        className="flex flex-col gap-3"
      >
        {result ? (
          <Outcome rows={result.results} titles={reviewed.titles} applied />
        ) : preview.isPending ? (
          <p className="text-body text-fg-muted">{tTasks("impactLoading")}</p>
        ) : preview.isError ? (
          <p className="text-body text-danger">{texts.failure(preview.error.failure)}</p>
        ) : (
          <Outcome rows={preview.data.results} titles={reviewed.titles} applied={false} />
        )}
        {!result && preview.data ? <Warnings rows={willChange} choice={reviewed.choice} /> : null}
        {apply.error ? (
          <FormAlert tone="error" announce>
            <p>{texts.failure(apply.error.failure)}</p>
          </FormAlert>
        ) : null}
      </div>
    </Dialog>
  );
}

function Outcome({
  rows,
  titles,
  applied,
}: {
  readonly rows: readonly BulkResult[];
  readonly titles: ReadonlyMap<string, string>;
  readonly applied: boolean;
}) {
  const t = useTranslations("TaskBulk");
  const changed = rows.filter((row) => row.outcome === (applied ? "changed" : "will_change"));
  const unchanged = rows.filter((row) => row.outcome === "unchanged");
  const excluded = rows.filter(
    (row) =>
      row.outcome !== "changed" && row.outcome !== "will_change" && row.outcome !== "unchanged",
  );
  const title = (row: BulkResult) => titles.get(row.taskId) ?? t("unknownTask");
  return (
    <div className="flex flex-col gap-2 text-body text-fg" data-testid="bulk-outcome">
      <p className="font-medium" role={applied ? "status" : undefined}>
        {applied
          ? excluded.length === 0
            ? t("resultAll", { count: changed.length })
            : t("resultPartial", { changed: changed.length, total: rows.length })
          : t("previewChange", { count: changed.length })}
      </p>
      {unchanged.length > 0 ? <p>{t("alreadySo", { count: unchanged.length })}</p> : null}
      {excluded.length > 0 ? (
        <>
          <p>
            {applied
              ? t("notChanged", { count: excluded.length })
              : t("excluded", { count: excluded.length })}
          </p>
          <ul className="flex list-disc flex-col gap-1 ps-5" data-testid="bulk-excluded">
            {excluded.map((row) => (
              <li key={row.taskId}>
                <bdi>{title(row)}</bdi>: {t(reasonKey[row.outcome])}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Warnings({
  rows,
  choice,
}: {
  readonly rows: readonly BulkResult[];
  readonly choice: BulkChoice;
}) {
  const t = useTranslations("TaskBulk");
  const subtasks = rows.filter((row) => (row.openSubtasks ?? 0) > 0).length;
  const shared = rows.filter((row) => row.shared === true).length;
  const recurring = rows.filter((row) => row.recurring === true).length;
  const items = [
    choice.action === "complete" && subtasks > 0 ? t("warnSubtasks", { count: subtasks }) : null,
    choice.action === "complete" && shared > 0 ? t("warnShared", { count: shared }) : null,
    recurring > 0 ? t("warnRecurring", { count: recurring }) : null,
  ].filter((item): item is string => item !== null);
  if (items.length === 0) return null;
  return (
    <FormAlert tone="info">
      <ul className="flex list-disc flex-col gap-1 ps-5" data-testid="bulk-warnings">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </FormAlert>
  );
}
