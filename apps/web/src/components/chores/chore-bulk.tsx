"use client";

import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_BULK_ENDPOINT,
  sendChoreRequest,
  type BulkOutcome,
  type BulkResponse,
  type BulkResult,
} from "@/chores/api";
import {
  bulkActions,
  CHORE_LIMITS,
  normalizeShortText,
  type BulkAction,
  type BulkInput,
} from "@/chores/schema";
import type { DateFormat } from "@/preferences/schema";
import { formatTaskDate, memberNames, type MemberOption } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

/** An occurrence the manager can select, as the overview shows it. */
export interface BulkRow {
  readonly id: string;
  readonly title: string;
  readonly dueDate: string;
  readonly revision: number;
  readonly pending: boolean;
}

const actionKey = {
  reassign: "bulkReassign",
  skip: "bulkSkip",
  due_date: "bulkDueDate",
} as const satisfies Record<BulkAction, string>;

const outcomeKey = {
  preview: "bulkOutcomePreview",
  saved: "bulkOutcomeSaved",
  skipped: "bulkOutcomeSkipped",
  not_found: "bulkOutcomeNotFound",
  not_permitted: "bulkOutcomeNotPermitted",
  conflict: "bulkOutcomeConflict",
  occurrence_closed: "bulkOutcomeClosed",
  pending_approval: "bulkOutcomePending",
  invalid_assignee: "bulkOutcomeInvalidAssignee",
  needs_confirmation: "bulkOutcomeFailed",
  failed: "bulkOutcomeFailed",
} as const satisfies Record<BulkOutcome, string>;

const applied = (outcome: BulkOutcome) => outcome === "saved" || outcome === "skipped";

/**
 * Changing several occurrences at once (S20, chore managers; spec "Confirmed limited bulk chore
 * occurrence management"): select open occurrences of this Home, choose one action (reassign to one
 * member, skip with an optional reason, or a new due date), review a per-occurrence preview (before
 * and after, and why any would not change), then confirm. Only the selected occurrences change,
 * never a series or its rotation; each is checked again with the revision shown, so the result
 * lists what changed and what did not, with the reason.
 */
export function ChoreBulk({
  homeId,
  rows,
  members,
  today,
  dateFormat,
}: {
  readonly homeId: string;
  readonly rows: readonly BulkRow[];
  readonly members: readonly MemberOption[];
  readonly today: string;
  readonly dateFormat: DateFormat;
}) {
  const t = useTranslations("Chores");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useChoreTexts(names);
  const { announce, region } = useAnnouncer();
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [action, setAction] = useState<BulkAction>("reassign");
  const [member, setMember] = useState(members[0]?.id ?? "");
  const [dueDate, setDueDate] = useState(today);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<readonly BulkResult[] | null>(null);
  const [results, setResults] = useState<readonly BulkResult[] | null>(null);
  const formats = { dateFormat };
  const titles = new Map(rows.map((row) => [row.id, row.title]));
  const reasonText = normalizeShortText(reason);
  const reasonTooLong = reasonText !== null && reasonText.length > CHORE_LIMITS.reason;
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(dueDate);

  const send = (items: BulkInput["items"], dryRun: boolean) =>
    sendChoreRequest<BulkResponse>("POST", CHORE_BULK_ENDPOINT, {
      homeId,
      action,
      items,
      dryRun,
      ...(action === "reassign" ? { member } : {}),
      ...(action === "due_date" ? { dueDate } : {}),
      ...(action === "skip" ? { reason: reasonText } : {}),
    });
  const review = useChoreMutation(
    `chore-bulk:${homeId}`,
    () =>
      send(
        rows
          .filter((row) => selected.has(row.id))
          .map((row) => ({ id: row.id, revision: row.revision })),
        true,
      ),
    (response) => {
      setResults(null);
      setPreview(response.results);
    },
    { refresh: () => false },
  );
  const apply = useChoreMutation(
    `chore-bulk:${homeId}`,
    (input: { items: BulkInput["items"]; leftOut: readonly BulkResult[] }) =>
      send(input.items, false),
    (response, input) => {
      // What the preview already left out is part of the result, with its reason.
      const all = [...response.results, ...input.leftOut];
      const done = all.filter((result) => applied(result.outcome)).length;
      setPreview(null);
      setResults(all);
      setSelected(new Set());
      announce(t("bulkAnnounce", { done, notDone: all.length - done }));
    },
  );
  const eligible = preview?.filter((result) => result.outcome === "preview") ?? [];
  const valueReady =
    action === "reassign" ? member !== "" : action === "due_date" ? dateValid : !reasonTooLong;

  const who = (ids: readonly (string | null)[] | null) =>
    ids === null
      ? ""
      : ids.length === 0
        ? t("unassigned")
        : ids.map((id) => texts.member(id)).join(", ");
  const change = (result: BulkResult) => {
    if (action === "reassign") {
      return t("bulkChangeAssignees", {
        before: who(result.assigneesBefore),
        after: who(result.assigneesAfter),
      });
    }
    if (action === "due_date") {
      return t("bulkChangeDue", {
        before: result.dueBefore ? formatTaskDate(result.dueBefore, formats) : "",
        after: result.dueAfter ? formatTaskDate(result.dueAfter, formats) : "",
      });
    }
    return t("bulkChangeSkip");
  };
  const resultTitle = (result: BulkResult) =>
    result.title ?? titles.get(result.occurrenceId) ?? t("bulkUnknownChore");

  if (rows.length === 0) return null;

  return (
    <HydrationGate>
      {region}
      {!open ? (
        <div>
          <Button
            ref={opener}
            variant="secondary"
            onClick={() => {
              setOpen(true);
              setResults(null);
            }}
            data-testid="chore-bulk-open"
          >
            {t("bulkOpen")}
          </Button>
        </div>
      ) : (
        <section
          aria-labelledby="chore-bulk-heading"
          className="flex flex-col gap-4 rounded-card border border-accent-edge bg-accent-subtle p-4"
          data-testid="chore-bulk"
        >
          <h2 id="chore-bulk-heading" className="text-section-title font-semibold text-fg">
            {t("bulkHeading")}
          </h2>
          <p className="text-helper text-fg-muted">{t("bulkHelp")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <p
              className="text-body font-medium text-fg"
              aria-live="polite"
              data-testid="chore-bulk-count"
            >
              {t("bulkSelected", { count: selected.size })}
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setSelected(new Set(rows.slice(0, CHORE_LIMITS.bulkItems).map((row) => row.id)));
              }}
            >
              {t("bulkSelectAll", { count: Math.min(rows.length, CHORE_LIMITS.bulkItems) })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={selected.size === 0}
              onClick={() => {
                setSelected(new Set());
              }}
            >
              {t("bulkClear")}
            </Button>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">{t("bulkChoose")}</legend>
            {rows.map((row) => (
              <Checkbox
                key={row.id}
                label={`${row.title} \u{00B7} ${t("dueOn", { date: formatTaskDate(row.dueDate, formats) })}${
                  row.pending ? ` \u{00B7} ${t("pendingMark")}` : ""
                }`}
                checked={selected.has(row.id)}
                disabled={!selected.has(row.id) && selected.size >= CHORE_LIMITS.bulkItems}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(row.id);
                  else next.delete(row.id);
                  setSelected(next);
                }}
                data-testid="chore-bulk-checkbox"
              />
            ))}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label={t("bulkAction")}
              options={bulkActions.map((value) => ({ value, label: t(actionKey[value]) }))}
              value={action}
              onChange={(event) => {
                setAction(event.target.value as BulkAction);
              }}
              data-testid="chore-bulk-action"
            />
            {action === "reassign" ? (
              <SelectField
                label={t("bulkMember")}
                options={members.map((option) => ({
                  value: option.id,
                  label: option.isSelf ? t("personYou") : (option.name ?? t("personUnnamed")),
                }))}
                value={member}
                onChange={(event) => {
                  setMember(event.target.value);
                }}
                data-testid="chore-bulk-member"
              />
            ) : null}
            {action === "due_date" ? (
              <TextField
                type="date"
                label={t("bulkNewDueDate")}
                description={t("bulkNewDueDateHelp")}
                value={dueDate}
                onChange={(event) => {
                  setDueDate(event.target.value);
                }}
                error={dateValid ? undefined : t("fieldDateRequired")}
                data-testid="chore-bulk-date"
              />
            ) : null}
          </div>
          {action === "skip" ? (
            <TextArea
              label={t("fieldReason")}
              description={t("fieldReasonHelp", { max: CHORE_LIMITS.reason })}
              rows={2}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              error={reasonTooLong ? t("fieldTooLong") : undefined}
            />
          ) : null}
          {review.error ? (
            <FormAlert tone="error" announce>
              {texts.failure(review.error.failure)}
            </FormAlert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={selected.size === 0 || !valueReady}
              loading={review.busy}
              onClick={() => {
                apply.reset();
                review.mutate(undefined);
              }}
              data-testid="chore-bulk-review"
            >
              {t("bulkReview", { count: selected.size })}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
                setSelected(new Set());
                requestAnimationFrame(() => opener.current?.focus());
              }}
            >
              {t("bulkExit")}
            </Button>
          </div>
          {results ? (
            <div className="flex flex-col gap-2" data-testid="chore-bulk-results">
              <p className="text-body font-medium text-fg">
                {t("bulkResultSummary", {
                  done: results.filter((result) => applied(result.outcome)).length,
                  notDone: results.filter((result) => !applied(result.outcome)).length,
                })}
              </p>
              <ul className="flex flex-col gap-1 text-body">
                {results.map((result) => (
                  <li key={result.occurrenceId} className="text-fg">
                    <bdi className="font-medium">{resultTitle(result)}</bdi>
                    {": "}
                    {t(outcomeKey[result.outcome])}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      )}
      <Dialog
        open={preview !== null}
        onClose={() => {
          setPreview(null);
        }}
        title={t("bulkPreviewTitle", { action: t(actionKey[action]) })}
        description={t("bulkPreviewBody", {
          eligible: eligible.length,
          total: preview?.length ?? 0,
        })}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setPreview(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              variant={action === "skip" ? "destructive" : "primary"}
              disabled={eligible.length === 0}
              loading={apply.busy}
              onClick={() => {
                apply.mutate({
                  items: eligible.flatMap((result) =>
                    result.revision === null
                      ? []
                      : [{ id: result.occurrenceId, revision: result.revision }],
                  ),
                  leftOut: (preview ?? []).filter((result) => result.outcome !== "preview"),
                });
              }}
              data-testid="chore-bulk-confirm"
            >
              {t("bulkApply", { count: eligible.length })}
            </Button>
          </>
        }
      >
        <ul className="flex flex-col divide-y divide-line" data-testid="chore-bulk-preview">
          {(preview ?? []).map((result) => (
            <li key={result.occurrenceId} className="flex flex-col gap-0.5 py-2 text-body">
              <bdi className="font-medium text-fg">{resultTitle(result)}</bdi>
              {result.outcome === "preview" ? (
                <span className="text-fg">{change(result)}</span>
              ) : (
                <span className="font-semibold text-fg">
                  {t("bulkNotChanged", { reason: t(outcomeKey[result.outcome]) })}
                </span>
              )}
            </li>
          ))}
        </ul>
        {apply.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(apply.error.failure)}
          </FormAlert>
        ) : null}
      </Dialog>
    </HydrationGate>
  );
}
