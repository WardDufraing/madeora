"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { GOAL_LIMITS, goalProgress, parseGoalQuantity } from "@madeora/domain/goals";
import { thousandthsToDecimal, toThousandths, type HabitUnit } from "@madeora/domain/habits";

import { FormAlert } from "@/components/auth/form-alert";
import { QuantityField } from "@/components/habits/numeric-fields";
import { Button } from "@/components/ui/button";
import { TextArea } from "@/components/ui/text-area";
import { useToast } from "@/components/ui/toast";
import {
  goalEndpoint,
  goalEntryEndpoint,
  GoalRequestError,
  sendGoalRequest,
  type GoalEntryResult,
  type GoalSummary,
} from "@/goals/api";
import { newId } from "@/goals/format";
import { goalNoteSchema } from "@/goals/schema";

import { useGoalMutation } from "./use-goal-mutation";
import { useGoalTexts } from "./use-goal-texts";

/** How long Undo stays offered after adding progress (brief: 10 seconds). */
export const PROGRESS_UNDO_MS = 10_000;

/** A measurable goal's unit as the domain helpers take it. */
export function goalUnit(goal: Pick<GoalSummary, "unit" | "unitKind">): HabitUnit | null {
  return goal.unit === null || goal.unitKind === null
    ? null
    : { unit: goal.unit, kind: goal.unitKind };
}

/** The goal's state as a short label; Overdue is a label, never a failure. */
export function GoalStatusLabel({ goal }: { readonly goal: Pick<GoalSummary, "status"> }) {
  const texts = useGoalTexts();
  const tone =
    goal.status === "overdue"
      ? "border-warning text-fg"
      : goal.status === "achieved"
        ? "border-success text-fg"
        : "border-line text-fg-muted";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 text-helper font-medium ${tone}`}
      data-testid="goal-status"
    >
      {texts.status(goal.status)}
    </span>
  );
}

/**
 * Progress of a measurable goal: the uncapped amount against the target, the percentage, a bar that
 * stops at 100%, and how far above the target it is. "Target reached" never achieves by itself.
 */
export function GoalProgressMeter({
  goal,
  compact = false,
}: {
  readonly goal: GoalSummary;
  readonly compact?: boolean;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  if (goal.kind !== "measurable" || goal.target === null) return null;
  const progress = goalProgress(toThousandths(goal.total), toThousandths(goal.target));
  const summary = texts.progress(goal);
  return (
    <div className="flex flex-col gap-1.5" data-testid="goal-progress">
      <p className="text-body font-medium text-fg">
        <span data-testid="goal-progress-text">{summary}</span>
        <span className="text-fg-muted"> · {t("percent", { percent: progress.percent })}</span>
      </p>
      <div
        role="progressbar"
        aria-label={t("progressBarLabel", { goal: goal.title })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, progress.percent)}
        aria-valuetext={t("progressValueText", { progress: summary, percent: progress.percent })}
        className={`${compact ? "h-1.5" : "h-2"} w-full overflow-hidden rounded-full bg-surface-sunken`}
      >
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${String(Math.round(progress.fraction * 100))}%` }}
        />
      </div>
      {progress.overTarget > 0 ? (
        <p className="text-helper text-fg-muted" data-testid="goal-over-target">
          {t("overTarget", {
            excess: texts.amount(progress.overTarget / 1000, goal.unit, goal.unitKind),
          })}
        </p>
      ) : null}
      {goal.reached && goal.status !== "achieved" ? (
        <p className="text-helper font-medium text-fg" data-testid="goal-target-reached">
          {t("targetReached")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Adds progress to a goal, with an Undo toast for ten seconds (a reversal of the person's own
 * contribution, checked again by the database).
 */
export function useAddProgress(goal: GoalSummary, source: "app" | "widget", onDone?: () => void) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const toast = useToast();
  const reverse = useGoalMutation(`goal:${goal.id}:undo`, (entryId: string) =>
    sendGoalRequest("PATCH", goalEntryEndpoint(entryId), { action: "reverse" }),
  );
  return useGoalMutation(
    `goal:${goal.id}`,
    (body: { id: string; quantity: string; note: string | null }) =>
      sendGoalRequest<GoalEntryResult>("POST", goalEndpoint(goal.id, "entries"), {
        ...body,
        mode: "add",
        source,
      }),
    (_result, body) => {
      onDone?.();
      const added = texts.amount(Number(body.quantity), goal.unit, goal.unitKind);
      toast.show({
        title: t("addedToast", { amount: added, goal: goal.title }),
        tone: "success",
        duration: PROGRESS_UNDO_MS,
        action: {
          label: t("undo"),
          onAction: () => {
            reverse.mutate(body.id, {
              onSuccess: () => {
                toast.show({ title: t("undoneToast", { amount: added, goal: goal.title }) });
              },
              onError: (error) => {
                toast.show({
                  title: texts.failure(
                    error instanceof GoalRequestError ? error.failure : "failed",
                  ),
                  tone: "error",
                });
              },
            });
          },
        },
      });
    },
  );
}

export interface ProgressFormProps {
  readonly goal: GoalSummary;
  /** `add` a contribution, or a manager's `total`. */
  readonly mode: "add" | "total";
  readonly source: "app" | "widget";
  /** The Home's name, shown in a widget so it is clear where the progress goes. */
  readonly homeName?: string | null;
  readonly compact?: boolean;
  readonly onDone?: () => void;
  readonly onCancel?: () => void;
}

/**
 * The amount editor: the current value and target, the amount typed in the viewer's locale, the
 * resulting total before anything is sent, and an optional note. "Set total" sends the total the
 * person saw, so a contribution made meanwhile is never overwritten (`stale`).
 */
export function ProgressForm({
  goal,
  mode,
  source,
  homeName,
  compact = false,
  onDone,
  onCancel,
}: ProgressFormProps) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const [id, setId] = useState(newId);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const unit = goalUnit(goal);
  const add = useAddProgress(goal, source, () => {
    setAmount("");
    setNote("");
    setId(newId());
    onDone?.();
  });
  const setTotal = useGoalMutation(
    `goal:${goal.id}`,
    (body: object) => sendGoalRequest("POST", goalEndpoint(goal.id, "entries"), body),
    () => {
      setAmount("");
      setNote("");
      setId(newId());
      onDone?.();
    },
  );
  const mutation = mode === "add" ? add : setTotal;
  if (!unit || goal.target === null) return null;
  const parsed =
    amount.trim() === ""
      ? null
      : parseGoalQuantity(amount, texts.locale, unit, { zero: mode === "total" });
  const current = toThousandths(goal.total);
  const resulting =
    parsed?.ok === true
      ? mode === "add"
        ? current + parsed.thousandths
        : parsed.thousandths
      : null;
  const label = mode === "add" ? t("amountLabel") : t("totalLabel");
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!parsed) {
          setError(texts.numeric.problem("empty"));
          return;
        }
        if (!parsed.ok) return;
        const checkedNote = goalNoteSchema.safeParse(note);
        if (!checkedNote.success) {
          setError(texts.field(checkedNote.error.issues[0]?.message));
          return;
        }
        setError(undefined);
        const quantity = thousandthsToDecimal(parsed.thousandths);
        if (mode === "add") {
          add.mutate({ id, quantity, note: checkedNote.data });
        } else {
          setTotal.mutate({
            id,
            mode: "total",
            quantity,
            note: checkedNote.data,
            source,
            expectedTotal: thousandthsToDecimal(current),
          });
        }
      }}
      data-testid={`goal-progress-form-${mode}`}
    >
      <p className="text-helper text-fg-muted">
        {t("currentLine", { progress: texts.progress(goal) })}
        {homeName ? ` · ${t("homeLine", { home: homeName })}` : ""}
      </p>
      <QuantityField
        label={label}
        description={t("amountHint", { unit: texts.numeric.unitLabel(unit.unit, unit.kind) })}
        value={amount}
        unit={unit}
        limits={{ max: GOAL_LIMITS.max, zero: mode === "total" }}
        error={error}
        onChange={setAmount}
        testId={`goal-${mode}-amount`}
      />
      {resulting !== null ? (
        <p className="text-body text-fg" aria-live="polite" data-testid="goal-resulting-total">
          {t("resultingTotal", {
            progress: texts.progress({ ...goal, total: resulting / 1000 }),
          })}
        </p>
      ) : null}
      {compact ? null : (
        <TextArea
          label={t("fieldNote")}
          description={t("fieldNoteHint", { max: GOAL_LIMITS.note })}
          rows={2}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          data-testid="goal-note"
        />
      )}
      {mutation.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(mutation.error.failure)}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            {t("cancel")}
          </Button>
        ) : null}
        <Button
          type="submit"
          size={compact ? "sm" : "md"}
          loading={mutation.busy}
          data-testid={`goal-${mode}-save`}
          {...(compact ? { "aria-label": t("addProgressTo", { goal: goal.title }) } : {})}
        >
          {mode === "add" ? t("addProgress") : t("setTotal")}
        </Button>
      </div>
    </form>
  );
}
