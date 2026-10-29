"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { z } from "zod";

import { HABIT_LIMITS, parseQuantity, thousandthsToDecimal } from "@madeora/domain/habits";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import {
  habitDayNoteEndpoint,
  habitEndpoint,
  HabitRequestError,
  sendHabitRequest,
  type HabitContributions,
  type HabitDetail,
  type HabitNumericDay,
  type HabitSummary,
} from "@/habits/api";
import { habitKeys } from "@/habits/format";
import { changeTrackingSchema, habitNoteSchema } from "@/habits/schema";
import {
  draftFromTracking,
  localizedDecimal,
  trackingFromDraft,
  type TrackingDraft,
  type TrackingErrors,
} from "@/habits/tracking-draft";
import { toThousandths } from "@madeora/domain/habits";
import type { MemberNames } from "@/tasks/format";

import { DialogActions, Failure, Preview } from "./habit-dialogs";
import { ProgressEntry, trackingUnit } from "./habit-progress";
import { QuantityField, QuickAddsEditor, TrackingFields } from "./numeric-fields";
import { useHabitContributions } from "./use-habit-contributions";
import { useHabitMutation } from "./use-habit-mutation";
import { useHabitTexts } from "./use-habit-texts";
import { useNumericTexts } from "./use-numeric-texts";

const date = z.iso.date();
const trackingJson = z.object({
  mode: z.enum(["once", "numeric"]),
  target: z.number().nullable(),
  unit: z.string().nullable(),
  unitKind: z.enum(["preset", "custom"]).nullable(),
});

// What a tracking preview answers (`change_habit_tracking`); anything else shows no details.
const trackingImpact = z.object({
  old: trackingJson,
  new: trackingJson,
  effectiveOn: date,
  relation: z.enum(["same", "compatible", "incompatible", "mode"]),
  converted: z.object({ target: z.number(), exact: z.boolean() }).nullable().optional(),
  today: z
    .object({
      total: z.number(),
      completedBefore: z.boolean(),
      completedAfter: z.boolean(),
      statusChange: z.boolean(),
    })
    .nullable()
    .optional(),
  nextDates: z.array(date).optional(),
  currentStreak: z.object({ current: z.int(), unit: z.enum(["occurrences", "weeks"]).nullable() }),
  reminders: z.boolean().optional(),
});

type When = "today" | "next" | "date";

function addDays(day: string, days: number): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/**
 * Changes how a habit is tracked: another target, another unit, or back to completing once. A mode
 * or unit change starts tomorrow or later; a new target alone may start today, on the next
 * scheduled day or on a chosen date. The preview shows what it does to today, to the streak and to
 * the units of earlier days, and asks for a separate confirmation when today's state flips.
 */
export function TrackingChangeDialog({
  habit,
  onClose,
}: {
  readonly habit: HabitDetail;
  readonly onClose: () => void;
}) {
  const t = useTranslations("HabitsNumeric");
  const texts = useHabitTexts();
  const numeric = useNumericTexts();
  const locale = useLocale();
  const current = habit.nextTracking ?? habit.tracking;
  const [draft, setDraft] = useState<TrackingDraft>(() => draftFromTracking(current, locale));
  const [errors, setErrors] = useState<TrackingErrors | undefined>(undefined);
  const [when, setWhen] = useState<When>("next");
  const [onDate, setOnDate] = useState(addDays(habit.today, 1));
  const [impact, setImpact] = useState<unknown>(null);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [confirmUnit, setConfirmUnit] = useState(false);
  const weekly = habit.schedule?.kind === "weekly" || habit.nextSchedule?.kind === "weekly";
  const reading = trackingFromDraft(draft, locale);
  // Only a target change within the unit in force may start today.
  const sameUnit =
    reading.ok &&
    reading.tracking !== null &&
    habit.tracking.mode === "numeric" &&
    habit.nextTracking === null &&
    habit.tracking.unit === reading.tracking.unit &&
    habit.tracking.unitKind === reading.tracking.unitKind;
  const effectiveWhen: When = when === "today" && !sameUnit ? "next" : when;
  const clear = () => {
    setImpact(null);
    setConfirmStatus(false);
    setConfirmUnit(false);
  };
  const send = (preview: boolean) => {
    setErrors(undefined);
    if (!reading.ok) {
      setErrors(reading.errors);
      return null;
    }
    const body = {
      revision: habit.revision,
      tracking: reading.tracking,
      when: effectiveWhen,
      effectiveOn: effectiveWhen === "date" ? onDate : null,
      // Today's total as the page showed it: a total that moved since is refused (`stale`).
      expectedTotal: effectiveWhen === "today" ? (habit.progress?.total ?? 0) : null,
      // A preview changes nothing, so it can show the consequences before they are confirmed.
      confirmStatus: preview ? true : confirmStatus,
      confirmUnit: preview ? true : confirmUnit,
      preview,
    };
    const parsed = changeTrackingSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  };
  const previewing = useHabitMutation(
    `habit:${habit.id}:tracking-preview`,
    (body: object) =>
      sendHabitRequest<{ impact: unknown }>("POST", habitEndpoint(habit.id, "tracking"), body),
    (answer) => {
      setImpact(answer.impact);
    },
  );
  const saving = useHabitMutation(
    `habit:${habit.id}:tracking`,
    (body: object) => sendHabitRequest("POST", habitEndpoint(habit.id, "tracking"), body),
    onClose,
  );
  const error = saving.error ?? previewing.error;
  const refusedImpact =
    error instanceof HabitRequestError && error.details.impact ? error.details.impact : null;
  const shown = trackingImpact.safeParse(refusedImpact ?? impact);
  const previewed = impact !== null;
  const unitChoice = shown.success && shown.data.relation === "incompatible";
  const statusFlip = shown.success && shown.data.today?.statusChange === true;
  const ready = previewed && (!unitChoice || confirmUnit) && (!statusFlip || confirmStatus);
  const whenOptions = [
    ...(sameUnit ? [{ value: "today", label: t("whenToday") }] : []),
    { value: "next", label: t("whenNext") },
    { value: "date", label: t("whenDate") },
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("changeTitle")}
      description={t("changeExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (previewed && ready) {
            const body = send(false);
            if (body) saving.mutate(body);
          } else if (!previewed) {
            const body = send(true);
            if (body) previewing.mutate(body);
          }
        }}
        data-testid="habit-tracking-form"
      >
        <TrackingFields
          value={draft}
          onChange={(next) => {
            clear();
            setDraft(next);
          }}
          weekly={weekly}
          errors={errors}
          withoutQuickAdds
        />
        <SelectField
          label={t("whenLabel")}
          description={sameUnit ? t("whenHintTarget") : t("whenHintUnit")}
          value={effectiveWhen}
          options={whenOptions}
          onChange={(event) => {
            clear();
            setWhen(event.target.value as When);
          }}
          data-testid="habit-tracking-when"
        />
        {effectiveWhen === "date" ? (
          <TextField
            label={t("whenDateLabel")}
            type="date"
            min={addDays(habit.today, sameUnit ? 0 : 1)}
            value={onDate}
            onChange={(event) => {
              clear();
              setOnDate(event.target.value);
            }}
            data-testid="habit-tracking-date"
          />
        ) : null}
        {shown.success ? (
          <Preview>
            <p className="text-body text-fg" data-testid="habit-tracking-preview">
              {t("previewChange", {
                from: trackingText(shown.data.old, numeric, t("trackingOnce")),
                to: trackingText(shown.data.new, numeric, t("trackingOnce")),
                date: texts.date(shown.data.effectiveOn, "short"),
              })}
            </p>
            {shown.data.relation === "compatible" && shown.data.converted ? (
              <p className="text-body text-fg">
                {t("previewConverted", {
                  target: numeric.amount(
                    shown.data.converted.target,
                    shown.data.new.unit ?? "",
                    shown.data.new.unitKind ?? "preset",
                  ),
                })}
              </p>
            ) : null}
            {shown.data.relation === "incompatible" ? (
              <p className="text-body text-fg">{t("previewIncompatible")}</p>
            ) : null}
            <p className="text-body text-fg">{t("previewHistoryKept")}</p>
            {shown.data.today ? (
              <p className="text-body text-fg" data-testid="habit-tracking-today">
                {shown.data.today.statusChange
                  ? shown.data.today.completedAfter
                    ? t("previewTodayCompletes", {
                        total: numeric.number(shown.data.today.total),
                      })
                    : t("previewTodayReopens", { total: numeric.number(shown.data.today.total) })
                  : t("previewTodayKept", { total: numeric.number(shown.data.today.total) })}
              </p>
            ) : null}
            <p className="text-body text-fg">
              {t("previewStreak", { streak: texts.streak(shown.data.currentStreak) })}
            </p>
            {shown.data.reminders ? (
              <p className="text-body text-fg">{t("previewReminders")}</p>
            ) : null}
          </Preview>
        ) : null}
        {previewed && unitChoice ? (
          <Checkbox
            label={t("confirmUnitLabel")}
            checked={confirmUnit}
            onChange={(event) => {
              setConfirmUnit(event.target.checked);
            }}
            data-testid="habit-tracking-confirm-unit"
          />
        ) : null}
        {previewed && statusFlip ? (
          <Checkbox
            label={t("confirmStatusLabel")}
            checked={confirmStatus}
            onChange={(event) => {
              setConfirmStatus(event.target.checked);
            }}
            data-testid="habit-tracking-confirm-status"
          />
        ) : null}
        {error?.failure === "unchanged" ? (
          <FormAlert tone="info" announce>
            {t("nothingToChange")}
          </FormAlert>
        ) : (
          <Failure error={error} />
        )}
        <DialogActions onClose={onClose}>
          <Button
            type="submit"
            loading={previewing.busy || saving.busy}
            disabled={previewed && !ready}
            data-testid="habit-tracking-submit"
          >
            {previewed ? t("confirmChange") : t("showPreview")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function trackingText(
  tracking: z.infer<typeof trackingJson>,
  numeric: ReturnType<typeof useNumericTexts>,
  once: string,
): string {
  return tracking.mode === "numeric" && tracking.target !== null && tracking.unit !== null
    ? numeric.amount(tracking.target, tracking.unit, tracking.unitKind ?? "preset")
    : once;
}

/** Edits the quick-add presets of the numeric tracking in effect. */
export function QuickAddsDialog({
  habit,
  onClose,
}: {
  readonly habit: HabitSummary;
  readonly onClose: () => void;
}) {
  const t = useTranslations("HabitsNumeric");
  const locale = useLocale();
  const unit = trackingUnit({ tracking: habit.nextTracking ?? habit.tracking });
  const [values, setValues] = useState<readonly string[]>(() =>
    (habit.nextTracking ?? habit.tracking).quickAdds.map((amount) =>
      localizedDecimal(toThousandths(amount), locale),
    ),
  );
  const [errors, setErrors] = useState<TrackingErrors["quickAdds"]>([]);
  const save = useHabitMutation(
    `habit:${habit.id}:quick-adds`,
    (quickAdds: readonly string[]) =>
      sendHabitRequest("PUT", habitEndpoint(habit.id, "quick-adds"), {
        revision: habit.revision,
        quickAdds,
      }),
    onClose,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("quickAddsDialogTitle")}
      description={t("quickAddsDialogExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const problems: (ReturnType<typeof checkPreset> | undefined)[] = values.map(
            (text, index) =>
              text.trim() === "" ? undefined : checkPreset(text, locale, unit, values, index),
          );
          setErrors(problems);
          if (problems.some((problem) => problem !== undefined)) return;
          const amounts = values
            .filter((text) => text.trim() !== "")
            .map((text) => {
              const parsed = parseQuantity(text, locale, unit ?? undefined);
              return parsed.ok ? thousandthsToDecimal(parsed.thousandths) : "0";
            });
          save.mutate(amounts);
        }}
      >
        <QuickAddsEditor
          values={values}
          onChange={(next) => {
            setErrors([]);
            setValues(next);
          }}
          unit={unit}
          errors={errors}
          testId="quick-adds-dialog"
        />
        <Failure error={save.error} />
        <DialogActions onClose={onClose}>
          <Button type="submit" loading={save.busy} data-testid="habit-quick-adds-save">
            {t("save")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function checkPreset(
  text: string,
  locale: string,
  unit: ReturnType<typeof trackingUnit>,
  values: readonly string[],
  index: number,
) {
  const parsed = parseQuantity(text, locale, unit ?? undefined);
  if (!parsed.ok) return parsed.problem;
  const same = values.findIndex((other) => {
    const reading = parseQuantity(other, locale, unit ?? undefined);
    return reading.ok && reading.thousandths === parsed.thousandths;
  });
  return same !== index ? ("duplicate" as const) : undefined;
}

/** Adds progress to an earlier day of the last eight, with the same entry as today's. */
export function AddProgressDialog({
  habit,
  day,
  onClose,
}: {
  readonly habit: HabitSummary;
  readonly day: HabitNumericDay;
  readonly onClose: () => void;
}) {
  const t = useTranslations("HabitsNumeric");
  const texts = useHabitTexts();
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("addToDayTitle")}
      description={t("addToDayExplanation", { date: texts.date(day.onDate, "short") })}
      closeLabel={t("close")}
    >
      <ProgressEntry habit={habit} onDate={day.onDate} onDone={onClose} />
    </Dialog>
  );
}

/** The one note of a numeric day, kept apart from the contributions. */
export function DayNoteDialog({
  habit,
  day,
  onClose,
}: {
  readonly habit: HabitSummary;
  readonly day: HabitNumericDay;
  readonly onClose: () => void;
}) {
  const t = useTranslations("HabitsNumeric");
  const th = useTranslations("Habits");
  const texts = useHabitTexts();
  const [note, setNote] = useState(day.note ?? "");
  const [error, setError] = useState<string | undefined>(undefined);
  const save = useHabitMutation(
    `habit:${habit.id}:day-note:${day.onDate}`,
    (value: string | null) =>
      sendHabitRequest("PUT", habitDayNoteEndpoint(habit.id, day.onDate), {
        revision: day.noteRevision,
        note: value,
      }),
    onClose,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("dayNoteTitle")}
      description={t("dayNoteExplanation", { date: texts.date(day.onDate, "short") })}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = habitNoteSchema.safeParse(note);
          if (!parsed.success) {
            setError(texts.field(parsed.error.issues[0]?.message));
            return;
          }
          setError(undefined);
          save.mutate(parsed.data);
        }}
      >
        <TextArea
          label={th("fieldNote")}
          description={th("fieldNoteHint", { max: HABIT_LIMITS.note })}
          rows={3}
          value={note}
          error={error}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          data-testid="habit-day-note-text"
        />
        <Failure error={save.error} />
        <DialogActions onClose={onClose}>
          <Button type="submit" loading={save.busy} data-testid="habit-day-note-save">
            {th("save")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/**
 * The contributions of one day the viewer may see: their own, or everyone's with who added them for
 * habit managers. Undo is the contributor's own (seven days); managers remove or amend any, and the
 * original is always kept.
 */
export function ContributionsDialog({
  habit,
  day,
  names,
  onClose,
}: {
  readonly habit: HabitSummary;
  readonly day: HabitNumericDay;
  readonly names: MemberNames;
  readonly onClose: () => void;
}) {
  const t = useTranslations("HabitsNumeric");
  const texts = useHabitTexts();
  const numeric = useNumericTexts();
  const locale = useLocale();
  const contributions = useHabitContributions(`habit:${habit.id}`);
  const [amending, setAmending] = useState<{ id: string; text: string } | null>(null);
  const [amendError, setAmendError] = useState<string | undefined>(undefined);
  const query = useQuery<{ contributions: HabitContributions }>({
    queryKey: [...habitKeys.all, "contributions", habit.id, day.onDate],
    queryFn: () =>
      sendHabitRequest(
        "GET",
        `${habitEndpoint(habit.id, "contributions")}?on=${encodeURIComponent(day.onDate)}`,
      ),
    staleTime: 0,
  });
  const data = query.data?.contributions;
  const unit = { unit: day.unit, kind: day.unitKind };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("contributionsTitle")}
      description={t("contributionsExplanation", { date: texts.date(day.onDate, "short") })}
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-3" data-testid="habit-contributions">
        {query.isError ? <p className="text-body text-danger">{t("contributionsFailed")}</p> : null}
        {data ? (
          <>
            <p className="text-body font-medium text-fg">
              {numeric.progress(data.total, day.target, day.unit, day.unitKind)}
            </p>
            {data.contributions.length === 0 ? (
              <p className="text-body text-fg-muted">{t("contributionsNone")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.contributions.map((contribution) => {
                  const rowId = contribution.id;
                  const editing = amending?.id === rowId;
                  return (
                    <li
                      key={rowId}
                      className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3"
                      data-testid="habit-contribution"
                      data-status={contribution.status}
                    >
                      <p className="text-body text-fg">
                        <span className={contribution.status === "undone" ? "line-through" : ""}>
                          {numeric.amount(contribution.quantity, day.unit, day.unitKind)}
                        </span>
                        {contribution.status === "undone"
                          ? ` · ${contribution.undoKind === "correction" ? t("statusRemoved") : t("statusUndone")}`
                          : ""}
                        {contribution.originalQuantity !== null
                          ? ` · ${t("amendedFrom", {
                              original: numeric.amount(
                                contribution.originalQuantity,
                                day.unit,
                                day.unitKind,
                              ),
                            })}`
                          : ""}
                      </p>
                      <p className="text-helper text-fg-muted">
                        {data.all
                          ? t("contributionBy", {
                              person: texts.who(contribution.by, contribution.mine, names),
                              time: new Intl.DateTimeFormat(locale, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }).format(new Date(contribution.recordedAt)),
                            })
                          : new Intl.DateTimeFormat(locale, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(contribution.recordedAt))}
                        {contribution.enteredQuantity !== null && contribution.enteredUnit
                          ? ` · ${t("enteredAs", {
                              amount: numeric.amount(
                                contribution.enteredQuantity,
                                contribution.enteredUnit,
                                "preset",
                              ),
                            })}`
                          : ""}
                      </p>
                      {contribution.undoReason ? (
                        <p className="text-helper text-fg-muted">
                          <bdi>{contribution.undoReason}</bdi>
                        </p>
                      ) : null}
                      {editing ? (
                        <div className="flex flex-wrap items-end gap-2">
                          <QuantityField
                            label={t("amendLabel")}
                            value={amending.text}
                            unit={unit}
                            error={amendError}
                            onChange={(text) => {
                              setAmendError(undefined);
                              setAmending({ id: rowId, text });
                            }}
                            testId="habit-amend-quantity"
                          />
                          <Button
                            size="sm"
                            loading={contributions.update.busy}
                            onClick={() => {
                              const parsed = parseQuantity(amending.text, locale, unit);
                              if (!parsed.ok) {
                                setAmendError(numeric.problem(parsed.problem));
                                return;
                              }
                              contributions.update.mutate(
                                {
                                  contributionId: rowId,
                                  name: habit.name,
                                  action: "amend",
                                  quantity: thousandthsToDecimal(parsed.thousandths),
                                },
                                {
                                  onSuccess: () => {
                                    setAmending(null);
                                  },
                                },
                              );
                            }}
                            data-testid="habit-amend-save"
                          >
                            {t("amendSave")}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setAmending(null);
                            }}
                          >
                            {t("cancel")}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {contribution.action === "undo" ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={contributions.update.busy}
                              onClick={() => {
                                contributions.reset();
                                contributions.update.mutate({
                                  contributionId: rowId,
                                  name: habit.name,
                                  action: "undo",
                                });
                              }}
                              data-testid="habit-contribution-undo"
                            >
                              {t("undo")}
                            </Button>
                          ) : null}
                          {contribution.action === "correct" ? (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  contributions.reset();
                                  setAmendError(undefined);
                                  setAmending({
                                    id: rowId,
                                    text: localizedDecimal(
                                      toThousandths(contribution.quantity),
                                      locale,
                                    ),
                                  });
                                }}
                                data-testid="habit-contribution-amend"
                              >
                                {t("amend")}
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                loading={contributions.update.busy}
                                onClick={() => {
                                  contributions.reset();
                                  contributions.update.mutate({
                                    contributionId: rowId,
                                    name: habit.name,
                                    action: "void",
                                  });
                                }}
                                data-testid="habit-contribution-void"
                              >
                                {t("remove")}
                              </Button>
                            </>
                          ) : null}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : query.isPending ? (
          <p className="text-body text-fg-muted">{t("loading")}</p>
        ) : null}
        {contributions.failureText ? (
          <FormAlert tone="error" announce>
            {contributions.failureText}
          </FormAlert>
        ) : null}
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
