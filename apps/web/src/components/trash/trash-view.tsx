"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { EmptyState } from "@/components/ui/states";
import { useHydrated } from "@/components/ui/use-hydrated";
import { formatDateTime, isolate, type DateTimeFormats } from "@/invitations/format";
import {
  emptyTrash,
  purgeEntries,
  restoreEntries,
  TrashRequestError,
  type PurgeResult,
  type RestoreResult,
  type TrashEntry,
  type TrashFailure,
} from "@/trash/api";
import {
  moveToListResolution,
  type TrashResolution,
  type TrashResolutionChoice,
} from "@/trash/schema";

export interface TrashViewProps {
  readonly entries: readonly TrashEntry[];
  /** `null`: the personal trash. */
  readonly homeId: string | null;
  /** The Home's name, for the confirmation texts (Home trash only). */
  readonly homeName: string | null;
  readonly formats: DateTimeFormats;
  /** True when filters hide some entries, so an empty list is explained correctly. */
  readonly filtered: boolean;
  /** When the page was loaded: "Empty trash" only touches what was deleted before this. */
  readonly loadedAt: string;
  /** The scope's active task lists, offered when a task's own list is gone (S18). */
  readonly taskLists?: readonly { readonly id: string; readonly name: string }[];
}

interface Conflict {
  readonly kind: string;
  readonly options: readonly TrashResolution[];
}

type Summary =
  | { readonly kind: "restore"; readonly results: readonly RestoreResult[] }
  | { readonly kind: "purge"; readonly results: readonly PurgeResult[] }
  | { readonly kind: "error"; readonly failure: TrashFailure };

type Confirm = "selected" | "empty" | null;

const itemTypeKey = {
  sample: "itemTypeSample",
  dashboard_template: "itemTypeDashboardTemplate",
  task: "itemTypeTask",
  task_list: "itemTypeTaskList",
  task_series_removal: "itemTypeTaskSeriesRemoval",
  task_attachment: "itemTypeTaskAttachment",
  task_series_attachment: "itemTypeTaskSeriesAttachment",
  chore: "itemTypeChore",
  chore_occurrence: "itemTypeChoreOccurrence",
  chore_removal: "itemTypeChoreRemoval",
  recipe: "itemTypeRecipe",
} as const;
function conflictMessage(kind: string) {
  switch (kind) {
    case "slot_taken":
      return "conflictSlotTaken";
    case "parent_unavailable":
      return "conflictParentUnavailable";
    case "list_unavailable":
      return "conflictListUnavailable";
    case "series_changed":
      return "conflictSeriesChanged";
    case "task_unavailable":
      return "conflictTaskUnavailable";
    case "series_unavailable":
      return "conflictSeriesUnavailable";
    case "attachment_limit":
      return "conflictAttachmentLimit";
    case "schedule_changed":
      return "conflictScheduleChanged";
    case "chore_unavailable":
      return "conflictChoreUnavailable";
    case "chore_limit":
      return "conflictChoreLimit";
    case "recipe_limit":
      return "conflictRecipeLimit";
    default:
      return "conflictOther";
  }
}
const resolutionKey = {
  clear_slot: "resolveClearSlot",
  detach_parent: "resolveDetachParent",
  restore_tasks_only: "resolveRestoreTasksOnly",
  restore_occurrences_only: "resolveRestoreOccurrencesOnly",
} as const satisfies Record<Exclude<TrashResolution, "move_to_list">, string>;
const errorKey = {
  signedOut: "errorSignedOut",
  invalid: "errorInvalid",
  network: "errorNetwork",
  failed: "errorFailed",
} as const;

function count(results: readonly { readonly outcome: string }[], outcome: string): number {
  return results.filter((result) => result.outcome === outcome).length;
}

/**
 * One trash (S16; spec "Confirmed central personal and Home trash organization"): the deleted
 * items the viewer may restore or delete now, with the day they stop being recoverable. Restoring
 * and deleting work on one item or a chosen set; every item is decided on its own and the result
 * says honestly how each went (restored, needs a choice, no longer available, failed). Nothing is
 * decided here: the buttons only send ids, and the server rechecks rights, deadline and conflicts
 * for each entry. Deleting permanently always asks for confirmation first.
 */
export function TrashView({
  entries,
  homeId,
  homeName,
  formats,
  filtered,
  loadedAt,
  taskLists = [],
}: TrashViewProps) {
  const t = useTranslations("Trash");
  const router = useRouter();
  const hydrated = useHydrated();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [conflicts, setConflicts] = useState<ReadonlyMap<string, Conflict>>(new Map());
  const summaryRef = useRef<HTMLDivElement>(null);
  const settled = useRef(false);

  // Only entries that are still listed can be selected: a refresh drops the ones just settled.
  const visible = useMemo(() => new Set(entries.map((entry) => entry.id)), [entries]);
  const chosen = useMemo(
    () => entries.filter((entry) => selected.has(entry.id)).map((entry) => entry.id),
    [entries, selected],
  );

  useEffect(() => {
    // After an action the buttons may become disabled: move focus to the result so it is announced
    // and the keyboard position is not lost.
    if (settled.current && summary) {
      settled.current = false;
      summaryRef.current?.focus();
    }
  }, [summary]);

  const scopeName = homeId ? t("scopeHome", { home: isolate(homeName ?? "") }) : t("scopePersonal");

  async function run(action: () => Promise<Summary>): Promise<void> {
    setBusy(true);
    try {
      const outcome = await action();
      setSummary(outcome);
    } catch (error) {
      setSummary({
        kind: "error",
        failure: error instanceof TrashRequestError ? error.failure : "failed",
      });
    } finally {
      setBusy(false);
      settled.current = true;
      setSelected(new Set());
      router.refresh();
    }
  }

  function restore(
    ids: readonly string[],
    resolutions: Record<string, TrashResolutionChoice> = {},
  ) {
    return run(async () => {
      const results = await restoreEntries(ids, resolutions);
      setConflicts((previous) => {
        const next = new Map(previous);
        for (const id of ids) next.delete(id);
        for (const result of results) {
          if (result.outcome === "needs_resolution" && result.conflict) {
            next.set(result.entryId, { kind: result.conflict, options: result.options });
          }
        }
        return next;
      });
      return { kind: "restore", results };
    });
  }

  function purge(ids: readonly string[]) {
    setConfirm(null);
    return run(async () => ({ kind: "purge", results: await purgeEntries(ids) }));
  }

  function empty() {
    setConfirm(null);
    return run(async () => ({ kind: "purge", results: await emptyTrash(homeId, loadedAt) }));
  }

  function toggle(id: string, on: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const allChosen = entries.length > 0 && chosen.length === entries.length;
  const disabled = busy || !hydrated;

  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="trash-view">
      <div
        ref={summaryRef}
        tabIndex={-1}
        className="flex flex-col gap-2 outline-none"
        data-testid="trash-result"
      >
        <TrashSummary summary={summary} />
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title={filtered ? t("emptyFilteredTitle") : t("emptyTitle")}
          description={filtered ? t("emptyFiltered") : t("empty")}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("actions")}>
            <Button
              variant="primary"
              disabled={disabled || chosen.length === 0}
              onClick={() => void restore(chosen)}
              data-testid="trash-restore"
            >
              {t("restoreSelected", { count: chosen.length })}
            </Button>
            <Button
              variant="secondary"
              disabled={disabled || chosen.length === 0}
              onClick={() => {
                setConfirm("selected");
              }}
              data-testid="trash-delete"
            >
              {t("deleteSelected", { count: chosen.length })}
            </Button>
            {/* With filters on, the list is only part of the trash: emptying is offered unfiltered. */}
            <Button
              variant="ghost"
              disabled={disabled || filtered}
              onClick={() => {
                setConfirm("empty");
              }}
              data-testid="trash-empty"
            >
              {t("emptyTrash")}
            </Button>
            {filtered ? (
              <p className="text-helper text-fg-muted">{t("emptyNeedsNoFilter")}</p>
            ) : null}
          </div>

          <fieldset className="flex flex-col gap-3" disabled={busy}>
            <legend className="sr-only">{t("listLabel")}</legend>
            <Checkbox
              label={t("selectAll", { count: entries.length })}
              checked={allChosen}
              onChange={(event) => {
                setSelected(event.target.checked ? new Set(visible) : new Set<string>());
              }}
              data-testid="trash-select-all"
            />
            <ul className="flex flex-col gap-3">
              {entries.map((entry) => {
                const conflict = conflicts.get(entry.id);
                return (
                  <li
                    key={entry.id}
                    className="rounded-control border border-line bg-surface p-3"
                    data-testid="trash-entry"
                  >
                    <Checkbox
                      label={entry.label}
                      description={[
                        t(itemTypeKey[entry.itemType]),
                        t("deletedOn", { date: formatDateTime(entry.deletedAt, formats) }),
                        t("recoverableUntil", { date: formatDateTime(entry.expiresAt, formats) }),
                        entry.fileCount > 0 ? t("withFiles", { count: entry.fileCount }) : null,
                        entry.deletedByMe && homeId ? t("deletedByYou") : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      checked={selected.has(entry.id)}
                      onChange={(event) => {
                        toggle(entry.id, event.target.checked);
                      }}
                    />
                    {conflict ? (
                      <div
                        className="mt-3 flex flex-col gap-2 border-t border-line pt-3"
                        data-testid="trash-conflict"
                      >
                        <p className="text-body text-fg">{t(conflictMessage(conflict.kind))}</p>
                        <div className="flex flex-wrap gap-2">
                          {conflict.options.map((option) =>
                            option === "move_to_list" ? (
                              <MoveToList
                                key={option}
                                lists={taskLists}
                                disabled={disabled}
                                onChoose={(listId) =>
                                  void restore([entry.id], {
                                    [entry.id]: moveToListResolution(listId),
                                  })
                                }
                              />
                            ) : (
                              <Button
                                key={option}
                                variant="secondary"
                                size="sm"
                                disabled={disabled}
                                onClick={() => void restore([entry.id], { [entry.id]: option })}
                              >
                                {t(resolutionKey[option])}
                              </Button>
                            ),
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={disabled}
                            onClick={() => {
                              setConflicts((previous) => {
                                const next = new Map(previous);
                                next.delete(entry.id);
                                return next;
                              });
                            }}
                          >
                            {t("resolveCancel")}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        </>
      )}

      <Dialog
        open={confirm === "selected"}
        onClose={() => {
          setConfirm(null);
        }}
        title={t("confirmDeleteTitle", { count: chosen.length })}
        description={t("confirmDeleteBody", { scope: scopeName })}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirm(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void purge(chosen)}
              data-testid="trash-confirm-delete"
            >
              {t("confirmDelete")}
            </Button>
          </>
        }
      />
      <Dialog
        open={confirm === "empty"}
        onClose={() => {
          setConfirm(null);
        }}
        title={t("confirmEmptyTitle")}
        description={t("confirmEmptyBody", { scope: scopeName, count: entries.length })}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirm(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void empty()}
              data-testid="trash-confirm-empty"
            >
              {t("confirmEmpty")}
            </Button>
          </>
        }
      />
    </div>
  );
}

/** Choosing another list of the same scope for a task whose list is gone (S18). */
function MoveToList({
  lists,
  disabled,
  onChoose,
}: {
  readonly lists: readonly { readonly id: string; readonly name: string }[];
  readonly disabled: boolean;
  readonly onChoose: (listId: string) => void;
}) {
  const t = useTranslations("Trash");
  const [listId, setListId] = useState(lists[0]?.id ?? "");
  if (lists.length === 0) return <p className="text-helper text-fg-muted">{t("resolveNoLists")}</p>;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <SelectField
        label={t("resolveMoveToListLabel")}
        value={listId}
        onChange={(event) => {
          setListId(event.target.value);
        }}
        options={lists.map((list) => ({ value: list.id, label: list.name }))}
        disabled={disabled}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || listId === ""}
        onClick={() => {
          onChoose(listId);
        }}
        data-testid="trash-move-to-list"
      >
        {t("resolveMoveToList")}
      </Button>
    </div>
  );
}

/** What the last action did, per outcome: never a plain "done" when something did not work. */
function TrashSummary({ summary }: { readonly summary: Summary | null }) {
  const t = useTranslations("Trash");
  if (!summary) return null;
  if (summary.kind === "error") {
    return (
      <FormAlert tone="error" announce>
        {t(errorKey[summary.failure])}
      </FormAlert>
    );
  }

  const results = summary.results;
  const done = count(results, summary.kind === "restore" ? "restored" : "purged");
  const unavailable = count(results, "not_found") + count(results, "expired");
  const failed = count(results, "failed");
  const needsChoice = count(results, "needs_resolution");
  const lost =
    summary.kind === "restore"
      ? (results as readonly RestoreResult[]).reduce(
          (sum, result) => sum + result.attachmentsLost,
          0,
        )
      : 0;
  // A full batch of Empty trash: more may remain, which the person must be told.
  const more = summary.kind === "purge" && results.length >= 200;
  const complete = unavailable + failed + needsChoice + lost === 0 && !more;

  return (
    <FormAlert tone={complete ? "success" : "info"} announce>
      <div className="flex flex-col gap-1">
        <p className="font-medium">
          {complete
            ? t(summary.kind === "restore" ? "resultRestoreDone" : "resultPurgeDone")
            : t("resultPartial")}
        </p>
        <ul className="list-disc ps-5">
          {done > 0 ? (
            <li>
              {t(summary.kind === "restore" ? "resultRestored" : "resultPurged", { count: done })}
            </li>
          ) : null}
          {needsChoice > 0 ? <li>{t("resultNeedsChoice", { count: needsChoice })}</li> : null}
          {unavailable > 0 ? (
            <li>
              {t(summary.kind === "restore" ? "resultUnavailable" : "resultNotDeleted", {
                count: unavailable,
              })}
            </li>
          ) : null}
          {failed > 0 ? <li>{t("resultFailed", { count: failed })}</li> : null}
          {lost > 0 ? <li>{t("resultAttachmentsLost", { count: lost })}</li> : null}
          {more ? <li>{t("resultMore")}</li> : null}
        </ul>
      </div>
    </FormAlert>
  );
}
