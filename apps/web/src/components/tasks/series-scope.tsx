"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { DateFormat } from "@/preferences/schema";
import {
  sendTaskRequest,
  TASKS_ENDPOINT,
  TaskRequestError,
  type SeriesChangeResponse,
  type SeriesDeleteResponse,
  type TaskDetail,
} from "@/tasks/api";
import { formatTaskDate, noMembers } from "@/tasks/format";
import type { SeriesChangeInput, SeriesScope } from "@/tasks/schema";

import { useTaskTexts } from "./use-task-texts";

/** Which occurrences a change or removal applies to (S19). */
export type OccurrenceScope = "this" | SeriesScope;

/** A series change without its scope and dry-run flag, which the dialog adds. */
export type SeriesChangeBody = Omit<SeriesChangeInput, "scope" | "dryRun">;

export function sendSeriesChange(
  taskId: string,
  scope: SeriesScope,
  body: SeriesChangeBody,
  dryRun: boolean,
): Promise<SeriesChangeResponse> {
  return sendTaskRequest<SeriesChangeResponse>("POST", `${TASKS_ENDPOINT}/${taskId}/series`, {
    ...body,
    scope,
    dryRun,
  });
}

export function sendSeriesDelete(
  task: TaskDetail,
  scope: SeriesScope,
  dryRun: boolean,
): Promise<SeriesDeleteResponse> {
  return sendTaskRequest<SeriesDeleteResponse>(
    "POST",
    `${TASKS_ENDPOINT}/${task.id}/series/delete`,
    { scope, expectedSeriesRevision: task.series?.revision ?? 1, dryRun },
  );
}

export type ScopeRequest =
  { readonly kind: "change"; readonly body: SeriesChangeBody } | { readonly kind: "delete" };

export interface SeriesScopeDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly task: TaskDetail;
  readonly title: string;
  /** What the change or removal is; the preview asks the server what it would do. */
  readonly request: ScopeRequest;
  /** Offers "Only this occurrence" (the S18 change of one task). */
  readonly allowThis: boolean;
  /** Offers following and all occurrences (the viewer may change the series). */
  readonly allowSeries: boolean;
  /** Shown above the choices, for example why only this occurrence can change. */
  readonly note?: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly busy: boolean;
  readonly dateFormat: DateFormat;
  readonly onConfirm: (scope: OccurrenceScope) => void;
  /** Extra inputs for the series scopes (such as copying the checklist). */
  readonly seriesOptions?: ReactNode;
  /** The failure of the last confirmation, shown in the dialog. */
  readonly error?: TaskRequestError | null;
}

/**
 * Asks which occurrences a change or removal applies to: only this one, this and following, or the
 * entire series (spec: recurring task edit scopes). For the series scopes it shows what would
 * happen, from the server's dry run of the same request: how many occurrences change or go to the
 * trash, which ones changed on their own stay, and that completed ones are never touched. Nothing
 * changes until the person confirms.
 */
export function SeriesScopeDialog({
  open,
  onClose,
  task,
  title,
  request,
  allowThis,
  allowSeries,
  note,
  confirmLabel,
  destructive = false,
  busy,
  dateFormat,
  onConfirm,
  seriesOptions,
  error,
}: SeriesScopeDialogProps) {
  const t = useTranslations("Tasks");
  const texts = useTaskTexts(noMembers);
  const name = useId();
  const series = task.series;
  // The server refuses "this and following" from a completed occurrence or an earlier part.
  const following = allowSeries && (series?.inHead ?? false) && task.completedAt === null;
  const options: OccurrenceScope[] = [
    ...(allowThis ? (["this"] as const) : []),
    ...(following ? (["following"] as const) : []),
    ...(allowSeries ? (["series"] as const) : []),
  ];
  // The dialog is mounted for one question at a time, so its choice starts fresh each time.
  const [scope, setScope] = useState<OccurrenceScope>(options[0] ?? "this");

  const previewKey = request.kind === "change" ? JSON.stringify(request.body) : "delete";
  const preview = useQuery<SeriesChangeResponse | SeriesDeleteResponse | null, TaskRequestError>({
    // Outside the `tasks` keys on purpose: a change invalidates those, and refetching the preview
    // of a change just made (or of a removed series) would only answer conflict or not found.
    // Never cached (gcTime 0), so it needs no account scope.
    queryKey: ["task-series-preview", task.id, request.kind, scope, previewKey],
    queryFn: () =>
      scope === "this"
        ? Promise.resolve(null)
        : request.kind === "change"
          ? sendSeriesChange(task.id, scope, request.body, true)
          : sendSeriesDelete(task, scope, true),
    enabled: open && scope !== "this",
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const failure = preview.error instanceof TaskRequestError ? preview.error : null;

  const labels = {
    this: t("scopeThis"),
    following: t("scopeFollowing"),
    series: t("scopeSeries"),
  } as const;
  const help = {
    this: request.kind === "delete" ? t("scopeThisDeleteHelp") : t("scopeThisHelp"),
    following: request.kind === "delete" ? t("scopeFollowingDeleteHelp") : t("scopeFollowingHelp"),
    series: request.kind === "delete" ? t("scopeSeriesDeleteHelp") : t("scopeSeriesHelp"),
  } as const;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t("close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            loading={busy}
            disabled={scope !== "this" && (preview.isPending || preview.isError)}
            onClick={() => {
              onConfirm(scope);
            }}
            data-testid="series-scope-confirm"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {note ? <p className="text-body text-fg">{note}</p> : null}
      {options.length > 1 ? (
        <fieldset className="flex flex-col gap-1" data-testid="series-scope">
          <legend className="mb-1 text-body font-medium text-fg">{t("scopeLegend")}</legend>
          {options.map((option) => (
            <RadioOption
              key={option}
              name={name}
              value={option}
              label={labels[option]}
              description={help[option]}
              checked={scope === option}
              onChange={() => {
                setScope(option);
              }}
            />
          ))}
        </fieldset>
      ) : null}
      {scope !== "this" ? seriesOptions : null}
      {scope !== "this" ? (
        <div
          className="rounded-card border border-line bg-surface-sunken p-3 text-body"
          aria-live="polite"
          aria-busy={preview.isPending}
          data-testid="series-impact"
        >
          {preview.isPending ? (
            <p className="text-fg-muted">{t("impactLoading")}</p>
          ) : preview.isError ? (
            <p className="text-danger">{texts.failure(failure?.failure ?? "failed")}</p>
          ) : preview.data ? (
            <Impact response={preview.data} dateFormat={dateFormat} />
          ) : null}
        </div>
      ) : null}
      {error ? (
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
      ) : null}
    </Dialog>
  );
}

function Impact({
  response,
  dateFormat,
}: {
  readonly response: SeriesChangeResponse | SeriesDeleteResponse;
  readonly dateFormat: DateFormat;
}) {
  const t = useTranslations("Tasks");
  const locale = useLocale();
  if ("trashEntryId" in response) {
    const impact = response.impact;
    return (
      <ul className="flex list-disc flex-col gap-1 ps-5 text-fg">
        <li>{t("impactTrashed", { count: impact.removed })}</li>
        <li>{t("impactCompletedKept", { count: impact.completed })}</li>
        <li>{impact.scope === "series" ? t("impactSeriesEnds") : t("impactFollowingEnds")}</li>
      </ul>
    );
  }
  const impact = response.impact;
  const dates = impact.nextDates.slice(0, 3).map((date) => formatTaskDate(date, { dateFormat }));
  return (
    <ul className="flex list-disc flex-col gap-1 ps-5 text-fg">
      <li>{t("impactUpdated", { count: impact.updated })}</li>
      {impact.kept > 0 ? <li>{t("impactDetachedKept", { count: impact.kept })}</li> : null}
      {impact.removed > 0 ? <li>{t("impactRemoved", { count: impact.removed })}</li> : null}
      <li>{t("impactCompletedKept", { count: impact.completed })}</li>
      {impact.selectedRemoved ? <li>{t("impactSelectedRemoved")}</li> : null}
      {impact.subtasksCopied > 0 ? (
        <li>{t("impactSubtasksCopied", { count: impact.subtasksCopied })}</li>
      ) : null}
      {dates.length > 0 ? (
        <li>
          {t("repeatNextDates", {
            dates: new Intl.ListFormat(locale, { type: "conjunction" }).format(dates),
          })}
        </li>
      ) : (
        <li>{t("impactNoNextDates")}</li>
      )}
    </ul>
  );
}
