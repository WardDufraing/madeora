"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import {
  GOAL_LIMITS,
  goalFrequencies,
  goalWeekStarts,
  isGoalFrequencyAllowed,
  parseGoalQuantity,
  type GoalFrequency,
  type GoalKind,
  type GoalWeekStart,
} from "@madeora/domain/goals";
import {
  HABIT_QUANTITY,
  habitUnits,
  thousandthsToDecimal,
  toThousandths,
  type QuantityProblem,
} from "@madeora/domain/habits";

import { FormAlert } from "@/components/auth/form-alert";
import { QuantityField } from "@/components/habits/numeric-fields";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import {
  GOAL_SERIES_ENDPOINT,
  GOALS_ENDPOINT,
  goalEndpoint,
  sendGoalRequest,
  type GoalSeriesCreateResult,
  type GoalSummary,
} from "@/goals/api";
import { goalSeriesPath, goalsPath, newId } from "@/goals/format";
import { createGoalSchema, createSeriesSchema, updateGoalSchema } from "@/goals/schema";
import { CUSTOM_UNIT, draftUnit, localizedDecimal } from "@/habits/tracking-draft";

import { useGoalMutation } from "./use-goal-mutation";
import { useGoalTexts } from "./use-goal-texts";

/** A context a new goal can go to: the Personal space (`null`) or a Home. */
export interface GoalContextOption {
  readonly homeId: string | null;
  readonly name: string;
}

export type GoalFormMode =
  | { readonly kind: "create"; readonly homeId: string | null }
  | { readonly kind: "edit"; readonly goal: GoalSummary }
  /** A new goal prefilled from a completed one; `target` overrides its target (a follow-up). */
  | { readonly kind: "renew"; readonly goal: GoalSummary; readonly target?: number };

interface FormValues {
  title: string;
  description: string;
  kind: GoalKind;
  unit: string;
  custom: string;
  deadline: string;
  timeZone: string;
  context: string;
  /** "none", or how a new goal repeats (a recurring series, S30b). */
  repeat: "none" | GoalFrequency;
  weekStart: GoalWeekStart;
  firstPeriod: string;
  endsOn: string;
  leadDays: string;
  leadTime: string;
}

type Field =
  "title" | "description" | "deadline" | "timeZone" | "firstPeriod" | "endsOn" | "leadDays";
const fields: readonly Field[] = [
  "title",
  "description",
  "deadline",
  "timeZone",
  "firstPeriod",
  "endsOn",
  "leadDays",
];

function isField(value: unknown): value is Field {
  return typeof value === "string" && (fields as readonly string[]).includes(value);
}

/** The context select's value for a Home id or the Personal space. */
const PERSONAL = "personal";

export interface GoalFormDialogProps {
  readonly mode: GoalFormMode;
  /** The contexts a new or renewed goal can go to (the database checks the person may create there). */
  readonly contexts: readonly GoalContextOption[];
  /** Today in the form's context, the earliest deadline. */
  readonly today: string;
  /** For personal goals: the viewer's effective timezone and the zones to offer. */
  readonly timeZone: string;
  readonly timeZones: readonly string[];
  /** The viewer's week start, the default for a weekly series. */
  readonly weekStart?: GoalWeekStart;
  readonly onClose: () => void;
}

/**
 * Creates a goal (title, type, target and unit for a measurable goal, initial progress, optional
 * deadline and description, and a personal goal's timezone), renews a completed one into a context
 * the person chooses (progress starts at 0), or edits a goal's title, description, deadline and
 * timezone. A target or unit changes elsewhere, with a preview. Errors are shown at their fields.
 * A new goal may repeat (S30b): weekly (measurable goals), monthly or yearly, from this period or a
 * later one, optionally until an end date and with an advance reminder; its first and next periods
 * are previewed before the series is created. A period's deadline comes from its series.
 */
export function GoalFormDialog({
  mode,
  contexts,
  today,
  timeZone,
  timeZones,
  weekStart = "monday",
  onClose,
}: GoalFormDialogProps) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const router = useRouter();
  const [id] = useState(newId);
  const source = mode.kind === "create" ? null : mode.goal;
  const editing = mode.kind === "edit" ? mode.goal : null;
  const initialHome = mode.kind === "create" ? mode.homeId : (source?.homeId ?? null);
  const sourceTarget =
    mode.kind === "renew" && mode.target !== undefined ? mode.target : (source?.target ?? null);
  const [target, setTarget] = useState(
    sourceTarget === null ? "" : localizedDecimal(toThousandths(sourceTarget), texts.locale),
  );
  const [initial, setInitial] = useState("");
  const [targetError, setTargetError] = useState<string | undefined>(undefined);
  const [initialError, setInitialError] = useState<string | undefined>(undefined);
  const form = useForm<FormValues>({
    defaultValues: {
      title: source?.title ?? "",
      description: source?.description ?? "",
      kind: source?.kind ?? "measurable",
      unit: source?.unitKind === "custom" ? CUSTOM_UNIT : (source?.unit ?? "pages"),
      custom: source?.unitKind === "custom" ? (source.unit ?? "") : "",
      deadline: editing?.deadline ?? "",
      timeZone: source?.timeZone ?? timeZone,
      context: initialHome ?? PERSONAL,
      repeat: "none",
      weekStart,
      firstPeriod: today,
      endsOn: "",
      leadDays: "",
      leadTime: "09:00",
    },
  });
  const errors = form.formState.errors;
  const [kind, unitCode, custom, context, repeat] = useWatch({
    control: form.control,
    name: ["kind", "unit", "custom", "context", "repeat"],
  });
  const recurring = mode.kind === "create" && repeat !== "none";
  const period = editing?.period ?? null;
  // A preview belongs to the values it was made for: any change asks for a new one before the
  // series is created.
  const draftKey = JSON.stringify([useWatch({ control: form.control }), target]);
  const submittedKey = useRef("");
  const [previewed, setPreviewed] = useState<{
    readonly key: string;
    readonly result: GoalSeriesCreateResult;
  } | null>(null);
  const preview = previewed?.key === draftKey ? previewed.result : null;
  const homeId = editing ? editing.homeId : context === PERSONAL ? null : context;
  const personal = homeId === null;
  const unit = draftUnit({ unit: unitCode, custom });
  const save = useGoalMutation(
    `goal:${editing?.id ?? id}`,
    (body: object) =>
      editing
        ? sendGoalRequest("PATCH", goalEndpoint(editing.id), body)
        : sendGoalRequest("POST", GOALS_ENDPOINT, body),
    () => {
      onClose();
      if (!editing) router.push(goalsPath(homeId, id));
    },
  );

  const createSeries = useGoalMutation(
    `goal-series:${id}`,
    (body: object) => sendGoalRequest<GoalSeriesCreateResult>("POST", GOAL_SERIES_ENDPOINT, body),
    (result) => {
      if (result.outcome === "preview") {
        setPreviewed({ key: submittedKey.current, result });
        return;
      }
      onClose();
      router.push(goalSeriesPath(homeId, id));
    },
  );

  const readQuantity = (
    text: string,
    zero: boolean,
  ): { ok: true; value: string | null } | { ok: false; problem: QuantityProblem } => {
    if (text.trim() === "")
      return zero ? { ok: true, value: null } : { ok: false, problem: "empty" };
    if (!unit) return { ok: false, problem: "malformed" };
    const parsed = parseGoalQuantity(text, texts.locale, unit, { zero });
    return parsed.ok
      ? { ok: true, value: thousandthsToDecimal(parsed.thousandths) }
      : { ok: false, problem: parsed.problem };
  };

  const submit = (values: FormValues) => {
    form.clearErrors();
    setTargetError(undefined);
    setInitialError(undefined);
    let first: Field | null = null;
    let quantitiesOk = true;
    let measure: { target: string; unit: string; unitKind: "preset" | "custom" } | null = null;
    let initialValue: string | null = null;
    if (!editing && values.kind === "measurable") {
      if (!unit) {
        form.setError("custom", { message: "required" });
        quantitiesOk = false;
      }
      const readTarget = readQuantity(target, false);
      if (!readTarget.ok) {
        setTargetError(texts.numeric.problem(readTarget.problem));
        quantitiesOk = false;
      } else if (unit && readTarget.value !== null) {
        measure = { target: readTarget.value, unit: unit.unit, unitKind: unit.kind };
      }
      if (mode.kind === "create" && !recurring) {
        const readInitial = readQuantity(initial, true);
        if (!readInitial.ok) {
          setInitialError(texts.numeric.problem(readInitial.problem));
          quantitiesOk = false;
        } else {
          initialValue = readInitial.value;
        }
      }
    }
    if (recurring && values.repeat !== "none") {
      const lead = values.leadDays.trim();
      const leadDays = lead === "" ? null : Number(lead);
      if (
        leadDays !== null &&
        (!Number.isInteger(leadDays) || leadDays < 1 || leadDays > GOAL_LIMITS.leadDays)
      ) {
        form.setError("leadDays", { message: "invalid" });
        first = "leadDays";
      }
      const seriesBody = {
        id,
        homeId,
        kind: values.kind,
        frequency: values.repeat,
        title: values.title,
        description: values.description,
        measure: values.kind === "measurable" ? measure : null,
        weekStart: values.weekStart,
        firstPeriod: values.firstPeriod,
        endsOn: values.endsOn === "" ? null : values.endsOn,
        timeZone: personal ? values.timeZone : null,
        reminder: leadDays === null ? null : { leadDays, atTime: values.leadTime },
        preview: preview === null,
      };
      const parsedSeries = createSeriesSchema.safeParse(seriesBody);
      if (!parsedSeries.success) {
        for (const issue of parsedSeries.error.issues) {
          const field = issue.path[0];
          if (isField(field) && !form.getFieldState(field).error) {
            form.setError(field, { message: issue.message });
            first ??= field;
          }
        }
      }
      if (first) form.setFocus(first);
      if (!parsedSeries.success || first || !quantitiesOk) return;
      submittedKey.current = draftKey;
      createSeries.mutate(parsedSeries.data);
      return;
    }
    const deadline = values.deadline === "" ? null : values.deadline;
    const deadlineChanged = deadline !== (editing?.deadline ?? null);
    if (deadline !== null && deadlineChanged && deadline < today) {
      form.setError("deadline", { message: "pastDeadline" });
      first = "deadline";
    }
    const body = editing
      ? {
          revision: editing.revision,
          title: values.title,
          description: values.description,
          deadline,
          timeZone: personal ? values.timeZone : null,
        }
      : {
          id,
          homeId,
          kind: values.kind,
          title: values.title,
          description: values.description,
          measure: values.kind === "measurable" ? measure : null,
          initial: values.kind === "measurable" ? initialValue : null,
          deadline,
          timeZone: personal ? values.timeZone : null,
          renewedFrom: mode.kind === "renew" ? mode.goal.id : null,
        };
    const parsed = (editing ? updateGoalSchema : createGoalSchema).safeParse(body);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (isField(field) && !form.getFieldState(field).error) {
          form.setError(field, { message: issue.message });
          first ??= field;
        }
      }
    }
    if (first) form.setFocus(first);
    if (!parsed.success || first || !quantitiesOk) return;
    save.mutate(parsed.data);
  };

  const formError = save.error ?? createSeries.error;
  const title =
    mode.kind === "edit" ? t("editTitle") : mode.kind === "renew" ? t("renewTitle") : t("newTitle");
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
      title={title}
      {...(mode.kind === "renew"
        ? { description: t("renewExplanation", { goal: mode.goal.title }) }
        : {})}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void form.handleSubmit(submit)(event);
        }}
        data-testid="goal-form"
      >
        {mode.kind === "renew" && contexts.length > 1 ? (
          <SelectField
            label={t("fieldContext")}
            description={t("fieldContextHint")}
            options={contexts.map((option) => ({
              value: option.homeId ?? PERSONAL,
              label: option.name,
            }))}
            data-testid="goal-context"
            {...form.register("context")}
          />
        ) : null}
        <TextField
          label={t("fieldTitle")}
          description={t("fieldTitleHint", { max: GOAL_LIMITS.title })}
          autoComplete="off"
          error={errors.title ? texts.field(errors.title.message) : undefined}
          data-testid="goal-title"
          {...form.register("title")}
        />
        {editing ? null : (
          <>
            <SelectField
              label={t("fieldKind")}
              description={t("fieldKindHint")}
              options={[
                { value: "measurable", label: t("kindMeasurable") },
                { value: "completion", label: t("kindCompletion") },
              ]}
              data-testid="goal-kind"
              {...form.register("kind")}
            />
            {kind === "measurable" ? (
              <>
                <SelectField
                  label={t("fieldUnit")}
                  options={unitOptions}
                  data-testid="goal-unit"
                  {...form.register("unit")}
                />
                {unitCode === CUSTOM_UNIT ? (
                  <TextField
                    label={t("fieldCustomUnit")}
                    description={t("fieldCustomUnitHint", {
                      max: HABIT_QUANTITY.customUnitLength,
                    })}
                    maxLength={HABIT_QUANTITY.customUnitLength * 2}
                    autoComplete="off"
                    error={errors.custom ? t("fieldUnitRequired") : undefined}
                    data-testid="goal-custom-unit"
                    {...form.register("custom")}
                  />
                ) : null}
                <QuantityField
                  label={t("fieldTarget")}
                  description={t("fieldTargetHint")}
                  value={target}
                  unit={unit}
                  limits={{ max: GOAL_LIMITS.max }}
                  error={targetError}
                  onChange={setTarget}
                  testId="goal-target"
                />
                {mode.kind === "create" && !recurring ? (
                  <QuantityField
                    label={t("fieldInitial")}
                    description={t("fieldInitialHint")}
                    value={initial}
                    unit={unit}
                    limits={{ max: GOAL_LIMITS.max, zero: true }}
                    error={initialError}
                    onChange={setInitial}
                    testId="goal-initial"
                  />
                ) : null}
              </>
            ) : null}
          </>
        )}
        {mode.kind === "create" ? (
          <SelectField
            label={t("fieldRepeat")}
            description={t("fieldRepeatHint")}
            options={[
              { value: "none", label: t("repeatNone") },
              ...goalFrequencies
                .filter((frequency) => isGoalFrequencyAllowed(kind, frequency))
                .map((frequency) => ({ value: frequency, label: texts.frequency(frequency) })),
            ]}
            error={
              repeat !== "none" && !isGoalFrequencyAllowed(kind, repeat)
                ? t("fieldRepeatWeeklyMeasurable")
                : undefined
            }
            data-testid="goal-repeat"
            {...form.register("repeat")}
          />
        ) : null}
        {recurring ? (
          <>
            {repeat === "weekly" ? (
              <SelectField
                label={t("fieldWeekStart")}
                options={goalWeekStarts.map((day) => ({ value: day, label: texts.weekStart(day) }))}
                data-testid="goal-week-start"
                {...form.register("weekStart")}
              />
            ) : null}
            <TextField
              label={t("fieldFirstPeriod")}
              description={t("fieldFirstPeriodHint")}
              type="date"
              min={today}
              error={errors.firstPeriod ? texts.field(errors.firstPeriod.message) : undefined}
              data-testid="goal-first-period"
              {...form.register("firstPeriod")}
            />
            <TextField
              label={t("fieldEndsOn")}
              description={t("fieldEndsOnHint")}
              type="date"
              min={today}
              error={errors.endsOn ? texts.field(errors.endsOn.message) : undefined}
              data-testid="goal-ends-on"
              {...form.register("endsOn")}
            />
            <TextField
              label={t("fieldSeriesLead")}
              description={t("fieldSeriesLeadHint", { max: GOAL_LIMITS.leadDays })}
              type="number"
              min={1}
              max={GOAL_LIMITS.leadDays}
              error={errors.leadDays ? t("fieldSeriesLeadInvalid") : undefined}
              data-testid="goal-series-lead"
              {...form.register("leadDays")}
            />
            <TextField
              label={t("remindersAt")}
              type="time"
              data-testid="goal-series-lead-time"
              {...form.register("leadTime")}
            />
          </>
        ) : period ? (
          <p className="text-helper text-fg-muted">{t("periodDeadlineFixed")}</p>
        ) : (
          <TextField
            label={t("fieldDeadline")}
            description={t("fieldDeadlineHint")}
            type="date"
            min={today}
            error={errors.deadline ? texts.field(errors.deadline.message) : undefined}
            data-testid="goal-deadline"
            {...form.register("deadline")}
          />
        )}
        <TextArea
          label={t("fieldDescription")}
          description={t("fieldOptional")}
          rows={3}
          error={errors.description ? texts.field(errors.description.message) : undefined}
          data-testid="goal-description"
          {...form.register("description")}
        />
        {personal && !period ? (
          <SelectField
            label={t("fieldTimeZone")}
            description={t("fieldTimeZoneHint")}
            options={timeZones.map((zone) => ({ value: zone, label: zone }))}
            error={errors.timeZone ? texts.field(errors.timeZone.message) : undefined}
            data-testid="goal-time-zone"
            {...form.register("timeZone")}
          />
        ) : null}
        {recurring && preview?.periods ? (
          <div
            className="flex flex-col gap-1 rounded-card border border-line bg-surface-muted p-3 text-body text-fg"
            role="status"
            data-testid="goal-series-preview"
          >
            <p className="font-medium">
              {preview.startsNow ? t("seriesPreviewStartsNow") : t("seriesPreviewStartsLater")}
            </p>
            <p>
              {t("seriesPreviewFirst", {
                period: texts.period(preview.periods.first.start, preview.periods.first.end),
              })}
            </p>
            {preview.periods.next ? (
              <p>
                {t("seriesPreviewNext", {
                  period: texts.period(preview.periods.next.start, preview.periods.next.end),
                })}
              </p>
            ) : (
              <p>{t("seriesPreviewOnlyOne")}</p>
            )}
            <p className="text-helper text-fg-muted">{t("seriesPreviewRules")}</p>
          </div>
        ) : null}
        {formError ? (
          <FormAlert tone="error" announce>
            {texts.failure(formError.failure)}
          </FormAlert>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={save.busy || createSeries.busy} data-testid="goal-save">
            {editing
              ? t("save")
              : recurring
                ? preview
                  ? t("createSeries")
                  : t("previewSeries")
                : t("create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
