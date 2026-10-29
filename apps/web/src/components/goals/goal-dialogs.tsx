"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { GOAL_LIMITS, parseGoalQuantity } from "@madeora/domain/goals";
import {
  HABIT_QUANTITY,
  habitUnits,
  thousandthsToDecimal,
  toThousandths,
} from "@madeora/domain/habits";

import { FormAlert } from "@/components/auth/form-alert";
import { QuantityField } from "@/components/habits/numeric-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useToast } from "@/components/ui/toast";
import type { GoalRequestError } from "@/goals/api";
import {
  goalEndpoint,
  goalEntryEndpoint,
  sendGoalRequest,
  type GoalDetail,
  type GoalEntry,
  type GoalMoment,
  type GoalRemindersResult,
  type GoalSummary,
  type GoalTargetImpact,
  type GoalTargetResult,
} from "@/goals/api";
import { goalsPath } from "@/goals/format";
import { goalReasonSchema } from "@/goals/schema";
import { CUSTOM_UNIT, draftUnit, localizedDecimal } from "@/habits/tracking-draft";
import type { MemberNames } from "@/tasks/format";

import { goalUnit, ProgressForm } from "./goal-progress";
import { useGoalMutation } from "./use-goal-mutation";
import { useGoalTexts } from "./use-goal-texts";

export function DialogActions({
  onClose,
  children,
}: {
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const t = useTranslations("Goals");
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="secondary" onClick={onClose}>
        {t("cancel")}
      </Button>
      {children}
    </div>
  );
}

export function Failure({ error }: { readonly error: GoalRequestError | null }) {
  const texts = useGoalTexts();
  return error ? (
    <FormAlert tone="error" announce>
      {texts.failure(error.failure)}
    </FormAlert>
  ) : null;
}

/** Add progress, or a manager's Set total, in a dialog. */
export function ProgressDialog({
  goal,
  mode,
  onClose,
}: {
  readonly goal: GoalSummary;
  readonly mode: "add" | "total";
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === "add" ? t("addProgressTitle") : t("setTotalTitle")}
      description={mode === "add" ? t("addProgressExplanation") : t("setTotalExplanation")}
      closeLabel={t("close")}
    >
      <ProgressForm goal={goal} mode={mode} source="app" onDone={onClose} onCancel={onClose} />
    </Dialog>
  );
}

/**
 * Corrects one entry: reverses it, or (goal managers) amends its quantity, with an optional reason.
 * The entry and the correction stay in the history.
 */
export function CorrectEntryDialog({
  goal,
  entry,
  names,
  onClose,
}: {
  readonly goal: GoalSummary;
  readonly entry: GoalEntry;
  readonly names: MemberNames;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const manager = entry.action === "correct";
  const [action, setAction] = useState<"reverse" | "amend">("reverse");
  const [quantity, setQuantity] = useState(() =>
    localizedDecimal(Math.abs(toThousandths(entry.quantity)), texts.locale),
  );
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  // The entry's own unit: a later confirmed unit change reinterprets numbers, never this record.
  const unit = goalUnit(entry);
  const correct = useGoalMutation(
    `goal:${goal.id}`,
    (body: object) => sendGoalRequest("PATCH", goalEntryEndpoint(entry.id), body),
    onClose,
  );
  // An adjustment can lower the total, so it keeps its sign; the others are 0 or more.
  const negative = entry.kind === "adjustment" && entry.quantity < 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={manager ? t("correctTitle") : t("reverseTitle")}
      description={t("correctExplanation", {
        amount: texts.amount(entry.quantity, entry.unit, entry.unitKind),
        person: texts.who(entry.by, entry.mine, names),
      })}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const checkedReason = goalReasonSchema.safeParse(reason);
          if (!checkedReason.success) {
            setError(texts.field(checkedReason.error.issues[0]?.message));
            return;
          }
          let amended: string | null = null;
          if (action === "amend") {
            if (!unit) return;
            const parsed = parseGoalQuantity(quantity, texts.locale, unit, {
              zero: entry.kind === "initial",
            });
            if (!parsed.ok) {
              setError(texts.numeric.problem(parsed.problem));
              return;
            }
            amended = `${negative ? "-" : ""}${thousandthsToDecimal(parsed.thousandths)}`;
          }
          setError(undefined);
          correct.mutate({
            action,
            ...(amended === null ? {} : { quantity: amended }),
            reason: checkedReason.data,
          });
        }}
        data-testid="goal-correct-form"
      >
        {manager ? (
          <SelectField
            label={t("correctAction")}
            value={action}
            options={[
              { value: "reverse", label: t("correctReverse") },
              { value: "amend", label: t("correctAmend") },
            ]}
            onChange={(event) => {
              setAction(event.target.value === "amend" ? "amend" : "reverse");
            }}
            data-testid="goal-correct-action"
          />
        ) : null}
        {action === "amend" ? (
          <QuantityField
            label={negative ? t("correctQuantityNegative") : t("correctQuantity")}
            value={quantity}
            unit={unit}
            limits={{ max: GOAL_LIMITS.max, zero: entry.kind === "initial" }}
            onChange={setQuantity}
            testId="goal-correct-quantity"
          />
        ) : null}
        <TextArea
          label={t("fieldReason")}
          description={t("fieldReasonHint", { max: GOAL_LIMITS.reason })}
          rows={2}
          value={reason}
          error={error}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          data-testid="goal-correct-reason"
        />
        <Failure error={correct.error} />
        <DialogActions onClose={onClose}>
          <Button type="submit" loading={correct.busy} data-testid="goal-correct-save">
            {action === "amend" ? t("correctAmend") : t("correctReverse")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function ImpactSummary({
  goal,
  impact,
}: {
  readonly goal: GoalSummary;
  readonly impact: GoalTargetImpact;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const after = texts.progress({
    total: impact.total,
    target: impact.targetAfter,
    unit: impact.unitAfter,
    unitKind: impact.unitKindAfter,
  });
  return (
    <div className="flex flex-col gap-1 text-body text-fg" data-testid="goal-target-impact">
      <p>{t("impactProgress", { before: texts.progress(goal), after })}</p>
      {impact.unitChanged ? <p>{t("impactUnit")}</p> : null}
      {impact.reopens ? <p>{t("impactReopens")}</p> : null}
      {impact.achieved && !impact.reopens ? <p>{t("impactStaysAchieved")}</p> : null}
    </div>
  );
}

/**
 * Changes a measurable goal's target and unit, after a preview: the progress before and after, a
 * unit change that reinterprets the existing numbers (never converts them), and an achieved goal
 * that would reopen. On an achieved goal it offers Extend this goal or Create a follow-up goal.
 */
export function TargetDialog({
  goal,
  onClose,
  onFollowUp,
}: {
  readonly goal: GoalSummary;
  readonly onClose: () => void;
  /** Opens the renew form with this target (thousandths), for a follow-up goal. */
  readonly onFollowUp: (target: number) => void;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const [target, setTarget] = useState(
    goal.target === null ? "" : localizedDecimal(toThousandths(goal.target), texts.locale),
  );
  const [unitCode, setUnitCode] = useState(
    goal.unitKind === "custom" ? CUSTOM_UNIT : (goal.unit ?? "pages"),
  );
  const [custom, setCustom] = useState(goal.unitKind === "custom" ? (goal.unit ?? "") : "");
  const [preview, setPreview] = useState<GoalTargetImpact | null>(null);
  const [confirmUnit, setConfirmUnit] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const unit = draftUnit({ unit: unitCode, custom });
  const achieved = goal.status === "achieved";
  const send = useGoalMutation(
    `goal:${goal.id}`,
    (body: object) =>
      sendGoalRequest<GoalTargetResult>("POST", goalEndpoint(goal.id, "target"), body),
    (result) => {
      if (result.outcome === "preview" || result.outcome === "unchanged") {
        setPreview(result.impact ?? null);
      } else {
        onClose();
      }
    },
  );
  const read = (): { target: string; unit: string; unitKind: "preset" | "custom" } | null => {
    if (!unit) {
      setError(t("fieldUnitRequired"));
      return null;
    }
    const parsed = parseGoalQuantity(target, texts.locale, unit);
    if (!parsed.ok) {
      setError(texts.numeric.problem(parsed.problem));
      return null;
    }
    setError(undefined);
    return {
      target: thousandthsToDecimal(parsed.thousandths),
      unit: unit.unit,
      unitKind: unit.kind,
    };
  };
  const refusedImpact =
    send.error && (send.error.failure === "confirmUnit" || send.error.failure === "confirmStatus")
      ? send.error.details.impact
      : undefined;
  const impact = refusedImpact ?? preview;
  const needsUnit = impact?.unitChanged === true && toThousandths(impact.total) !== 0;
  const needsStatus = impact?.reopens === true;
  const unitOptions = [
    ...habitUnits.map((definition) => ({
      value: definition.code,
      label: texts.numeric.unitOption(definition.code),
    })),
    { value: CUSTOM_UNIT, label: t("unitOptionCustom") },
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("targetTitle")}
      description={achieved ? t("targetExplanationAchieved") : t("targetExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const body = read();
          if (!body) return;
          send.mutate({ revision: goal.revision, ...body, preview: true });
        }}
        data-testid="goal-target-form"
      >
        <SelectField
          label={t("fieldUnit")}
          value={unitCode}
          options={unitOptions}
          onChange={(event) => {
            setUnitCode(event.target.value);
            setPreview(null);
          }}
          data-testid="goal-target-unit"
        />
        {unitCode === CUSTOM_UNIT ? (
          <TextField
            label={t("fieldCustomUnit")}
            description={t("fieldCustomUnitHint", { max: HABIT_QUANTITY.customUnitLength })}
            value={custom}
            maxLength={HABIT_QUANTITY.customUnitLength * 2}
            autoComplete="off"
            onChange={(event) => {
              setCustom(event.target.value);
              setPreview(null);
            }}
            data-testid="goal-target-custom-unit"
          />
        ) : null}
        <QuantityField
          label={t("fieldTarget")}
          value={target}
          unit={unit}
          limits={{ max: GOAL_LIMITS.max }}
          error={error}
          onChange={(text) => {
            setTarget(text);
            setPreview(null);
          }}
          testId="goal-target-value"
        />
        {impact ? <ImpactSummary goal={goal} impact={impact} /> : null}
        {needsUnit ? (
          <Checkbox
            label={t("confirmUnitLabel")}
            checked={confirmUnit}
            onChange={(event) => {
              setConfirmUnit(event.target.checked);
            }}
            data-testid="goal-confirm-unit"
          />
        ) : null}
        {needsStatus ? (
          <Checkbox
            label={t("confirmStatusLabel")}
            checked={confirmStatus}
            onChange={(event) => {
              setConfirmStatus(event.target.checked);
            }}
            data-testid="goal-confirm-status"
          />
        ) : null}
        <Failure
          error={
            send.error &&
            send.error.failure !== "confirmUnit" &&
            send.error.failure !== "confirmStatus"
              ? send.error
              : null
          }
        />
        <DialogActions onClose={onClose}>
          {achieved ? (
            <Button
              variant="secondary"
              onClick={() => {
                if (!unit) return;
                const parsed = parseGoalQuantity(target, texts.locale, unit);
                if (!parsed.ok) {
                  setError(texts.numeric.problem(parsed.problem));
                  return;
                }
                onFollowUp(parsed.thousandths);
              }}
              data-testid="goal-follow-up"
            >
              {t("followUp")}
            </Button>
          ) : null}
          <Button type="submit" variant="secondary" loading={send.busy && !impact}>
            {t("preview")}
          </Button>
          {impact ? (
            <Button
              disabled={(needsUnit && !confirmUnit) || (needsStatus && !confirmStatus)}
              loading={send.busy}
              onClick={() => {
                const body = read();
                if (!body) return;
                send.mutate({
                  revision: goal.revision,
                  ...body,
                  confirmUnit,
                  confirmStatus,
                });
              }}
              data-testid="goal-target-save"
            >
              {achieved ? t("extend") : t("save")}
            </Button>
          ) : null}
        </DialogActions>
      </form>
    </Dialog>
  );
}

function MomentList({
  moments,
  timeZone,
}: {
  readonly moments: readonly GoalMoment[];
  readonly timeZone: string;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  if (moments.length === 0) return null;
  return (
    <ul className="list-disc ps-5 text-body text-fg" data-testid="goal-reminder-moments">
      {moments.map((moment) => (
        <li key={`${moment.kind}-${moment.at}`}>
          {t(moment.kind === "lead" ? "momentLead" : "momentOverdue", {
            at: texts.instant(moment.at, timeZone),
          })}
          {moment.passed ? ` · ${t("momentPassed")}` : ""}
        </li>
      ))}
    </ul>
  );
}

/**
 * A goal's deadline reminders (goal managers): an advance reminder 1-90 days before, an overdue
 * reminder 0-30 days after, at one local time. The moments are previewed; one that already passed is
 * marked and will be skipped, never sent late.
 */
export function RemindersDialog({
  goal,
  onClose,
}: {
  readonly goal: GoalDetail;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  const reminder = goal.reminder;
  const [enabled, setEnabled] = useState(reminder?.enabled ?? true);
  const [lead, setLead] = useState(reminder?.leadDays?.toString() ?? "3");
  const [overdue, setOverdue] = useState(reminder?.overdueDays?.toString() ?? "0");
  const [useLead, setUseLead] = useState(reminder ? reminder.leadDays !== null : true);
  // A period of a series ends at its deadline: advance reminders only.
  const isPeriod = goal.period !== null;
  const [useOverdue, setUseOverdue] = useState(
    !isPeriod && (reminder ? reminder.overdueDays !== null : true),
  );
  const [atTime, setAtTime] = useState(reminder?.atTime ?? "09:00");
  const [moments, setMoments] = useState<readonly GoalMoment[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const send = useGoalMutation(
    `goal-reminders:${goal.id}`,
    (body: object) =>
      sendGoalRequest<GoalRemindersResult>("PUT", goalEndpoint(goal.id, "reminders"), body),
    (result) => {
      if (result.outcome === "preview") setMoments(result.moments ?? []);
      else onClose();
    },
  );
  const body = (preview: boolean): object | null => {
    const leadDays = useLead ? Number(lead) : null;
    const overdueDays = useOverdue ? Number(overdue) : null;
    if (
      enabled &&
      ((leadDays === null && overdueDays === null) ||
        (leadDays !== null &&
          (!Number.isInteger(leadDays) || leadDays < 1 || leadDays > GOAL_LIMITS.leadDays)) ||
        (overdueDays !== null &&
          (!Number.isInteger(overdueDays) ||
            overdueDays < 0 ||
            overdueDays > GOAL_LIMITS.overdueDays)) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(atTime))
    ) {
      setError(t("remindersInvalid"));
      return null;
    }
    setError(undefined);
    return {
      expectedRevision: reminder?.revision ?? 0,
      enabled,
      leadDays: enabled ? leadDays : null,
      overdueDays: enabled ? overdueDays : null,
      atTime,
      preview,
    };
  };
  const changed = () => {
    setMoments(null);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("remindersTitle")}
      description={
        goal.deadline
          ? t("remindersExplanation", { zone: goal.timeZone })
          : t("remindersNeedDeadline")
      }
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const next = body(false);
          if (next) send.mutate(next);
        }}
        data-testid="goal-reminders-form"
      >
        <Checkbox
          label={t("remindersEnabled")}
          checked={enabled}
          disabled={!goal.deadline}
          onChange={(event) => {
            setEnabled(event.target.checked);
            changed();
          }}
          data-testid="goal-reminders-enabled"
        />
        {enabled && goal.deadline ? (
          <>
            <Checkbox
              label={t("remindersLead")}
              checked={useLead}
              onChange={(event) => {
                setUseLead(event.target.checked);
                changed();
              }}
            />
            {useLead ? (
              <TextField
                label={t("remindersLeadDays")}
                description={t("remindersLeadDaysHint", { max: GOAL_LIMITS.leadDays })}
                type="number"
                min={1}
                max={GOAL_LIMITS.leadDays}
                value={lead}
                onChange={(event) => {
                  setLead(event.target.value);
                  changed();
                }}
                data-testid="goal-reminders-lead"
              />
            ) : null}
            {isPeriod ? null : (
              <>
                <Checkbox
                  label={t("remindersOverdue")}
                  checked={useOverdue}
                  onChange={(event) => {
                    setUseOverdue(event.target.checked);
                    changed();
                  }}
                />
                {useOverdue ? (
                  <TextField
                    label={t("remindersOverdueDays")}
                    description={t("remindersOverdueDaysHint", { max: GOAL_LIMITS.overdueDays })}
                    type="number"
                    min={0}
                    max={GOAL_LIMITS.overdueDays}
                    value={overdue}
                    onChange={(event) => {
                      setOverdue(event.target.value);
                      changed();
                    }}
                    data-testid="goal-reminders-overdue"
                  />
                ) : null}
              </>
            )}
            <TextField
              label={t("remindersAt")}
              type="time"
              value={atTime}
              onChange={(event) => {
                setAtTime(event.target.value);
                changed();
              }}
              data-testid="goal-reminders-time"
            />
          </>
        ) : null}
        {moments ? (
          moments.length > 0 ? (
            <MomentList moments={moments} timeZone={goal.timeZone} />
          ) : (
            <p className="text-body text-fg-muted">{t("remindersNone")}</p>
          )
        ) : null}
        {error ? (
          <FormAlert tone="error" announce>
            {error}
          </FormAlert>
        ) : null}
        <Failure error={send.error} />
        <DialogActions onClose={onClose}>
          {enabled && goal.deadline ? (
            <Button
              variant="secondary"
              loading={send.busy && moments === null}
              onClick={() => {
                const next = body(true);
                if (next) send.mutate(next);
              }}
              data-testid="goal-reminders-preview"
            >
              {t("preview")}
            </Button>
          ) : null}
          <Button
            type="submit"
            disabled={!goal.deadline && !reminder?.enabled}
            loading={send.busy}
            data-testid="goal-reminders-save"
          >
            {t("save")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Reopens an achieved goal (goal managers), with an optional reason; the achievement stays. */
export function ReopenDialog({
  goal,
  onClose,
}: {
  readonly goal: GoalSummary;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const reopen = useGoalMutation(
    `goal:${goal.id}`,
    (body: object) => sendGoalRequest("POST", goalEndpoint(goal.id, "achievement"), body),
    onClose,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("reopenTitle")}
      description={t("reopenExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const checked = goalReasonSchema.safeParse(reason);
          if (!checked.success) {
            setError(texts.field(checked.error.issues[0]?.message));
            return;
          }
          setError(undefined);
          reopen.mutate({ revision: goal.revision, achieved: false, reason: checked.data });
        }}
      >
        <TextArea
          label={t("fieldReason")}
          description={t("fieldReasonHint", { max: GOAL_LIMITS.reason })}
          rows={2}
          value={reason}
          error={error}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          data-testid="goal-reopen-reason"
        />
        <Failure error={reopen.error} />
        <DialogActions onClose={onClose}>
          <Button type="submit" loading={reopen.busy} data-testid="goal-reopen-confirm">
            {t("reopen")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Moves a goal to the trash, restorable unchanged for 7 days. */
export function DeleteDialog({
  goal,
  onClose,
}: {
  readonly goal: GoalSummary;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  const router = useRouter();
  const toast = useToast();
  const remove = useGoalMutation(
    `goal:${goal.id}`,
    () => sendGoalRequest("DELETE", goalEndpoint(goal.id), { revision: goal.revision }),
    () => {
      toast.show({ title: t("deletedToast", { goal: goal.title }), tone: "info" });
      router.push(goalsPath(goal.homeId));
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("deleteTitle")}
      description={t("deleteExplanation", { goal: goal.title })}
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-4">
        <Failure error={remove.error} />
        <DialogActions onClose={onClose}>
          <Button
            variant="destructive"
            loading={remove.busy}
            onClick={() => {
              remove.mutate(undefined);
            }}
            data-testid="goal-delete-confirm"
          >
            {t("delete")}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
