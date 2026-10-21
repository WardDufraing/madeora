"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import {
  draftRule,
  noRepeat,
  RepeatFields,
  repeatSchema,
  type RepeatError,
} from "@/components/tasks/repeat-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  assignmentModes,
  CHORE_LIMITS,
  choreTitleSchema,
  instructionsSchema,
  labelKey,
  stepLabelSchema,
  type AssignmentInput,
  type ChoreFieldError,
  type StepInput,
} from "@/chores/schema";
import type { DateFormat } from "@/preferences/schema";
import type { MemberOption } from "@/tasks/format";
import { dateOnlySchema, type RecurrenceInput } from "@/tasks/schema";

import { AssignmentEditor } from "./assignment-editor";
import { RotationPreview } from "./rotation-preview";
import { StepsEditor, type StepDraft } from "./steps-editor";

type FormError = ChoreFieldError | "minutes" | "rotationSize" | "dateRequired";

const stepRow = z.object({
  key: z.string(),
  id: z.string().nullable(),
  label: stepLabelSchema,
  mandatory: z.boolean(),
});

/** The checklist from its drafts, rows left empty dropped. */
export const stepDraftsSchema = z
  .array(
    z.object({
      key: z.string(),
      id: z.string().nullable(),
      label: z.string(),
      mandatory: z.boolean(),
    }),
  )
  .transform((steps) => steps.filter((step) => step.label.trim() !== ""))
  .pipe(
    z
      .array(stepRow)
      .max(CHORE_LIMITS.steps, { message: "tooLong" satisfies FormError })
      .refine((steps) => new Set(steps.map((step) => labelKey(step.label))).size === steps.length, {
        message: "duplicate" satisfies FormError,
      }),
  );

/** An estimate in whole minutes, or empty for none. */
export const minutesDraftSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) =>
      value === "" ||
      (/^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= CHORE_LIMITS.minutes),
    { message: "minutes" satisfies FormError },
  )
  .transform((value) => (value === "" ? null : Number(value)));

export const assignmentDraftSchema = z
  .object({ mode: z.enum(assignmentModes), members: z.array(z.string()) })
  .refine((value) => value.mode !== "fixed" || value.members.length >= 1, {
    message: "required" satisfies FormError,
  })
  .refine((value) => value.mode !== "rotating" || value.members.length >= 2, {
    message: "rotationSize" satisfies FormError,
  });

const formSchema = z
  .object({
    title: choreTitleSchema,
    instructions: instructionsSchema,
    categoryId: z.string(),
    minutes: minutesDraftSchema,
    /** A one-off chore's date, or a recurring chore's first date. */
    date: z.union([z.literal(""), dateOnlySchema]),
    repeat: repeatSchema,
    assignment: assignmentDraftSchema,
    steps: stepDraftsSchema,
    requiresApproval: z.boolean(),
  })
  .refine((chore) => chore.date !== "", {
    message: "dateRequired" satisfies FormError,
    path: ["date"],
  })
  .refine((chore) => chore.repeat !== null || chore.assignment.mode !== "rotating", {
    message: "invalid" satisfies FormError,
    path: ["assignment"],
  })
  .refine((chore) => chore.repeat?.endsOn == null || chore.repeat.endsOn >= chore.date, {
    message: "endsOn" satisfies RepeatError,
    path: ["repeat", "endsOn"],
  });
export type ChoreFormInput = z.input<typeof formSchema>;
type ChoreFormParsed = z.output<typeof formSchema>;

/** What the form produces: the create request without its ids. */
export interface ChoreFormOutput {
  readonly title: string;
  readonly instructions: string | null;
  readonly categoryId: string | null;
  readonly minutes: number | null;
  readonly steps: StepInput[];
  readonly assignment: AssignmentInput;
  readonly dueDate: string | null;
  readonly recurrence: RecurrenceInput | null;
  readonly requiresApproval: boolean;
}

function outputOf(values: ChoreFormParsed): ChoreFormOutput {
  return {
    title: values.title,
    instructions: values.instructions,
    categoryId: values.categoryId === "" ? null : values.categoryId,
    minutes: values.minutes,
    steps: values.steps.map(({ label, mandatory }) => ({ label, mandatory })),
    assignment: { mode: values.assignment.mode, members: [...values.assignment.members] },
    dueDate: values.repeat === null ? values.date : null,
    recurrence: values.repeat === null ? null : { ...values.repeat, startsOn: values.date },
    requiresApproval: values.requiresApproval,
  };
}

export const emptyChore = (today: string): ChoreFormInput => ({
  title: "",
  instructions: "",
  categoryId: "",
  minutes: "",
  date: today,
  repeat: noRepeat,
  assignment: { mode: "none", members: [] },
  steps: [] as StepDraft[],
  requiresApproval: false,
});

const fieldErrorKey = {
  required: "fieldRequired",
  tooLong: "fieldTooLong",
  invalidCharacters: "fieldInvalidCharacters",
  duplicate: "fieldDuplicateStep",
  invalid: "fieldInvalid",
  minutes: "fieldMinutesInvalid",
  rotationSize: "fieldRotationSize",
  dateRequired: "fieldDateRequired",
} as const satisfies Record<FormError, string>;

export function useChoreFieldMessage() {
  const t = useTranslations("Chores");
  return (error: { readonly message?: string | undefined } | undefined) => {
    const key = error?.message as FormError | undefined;
    return key && key in fieldErrorKey ? t(fieldErrorKey[key]) : undefined;
  };
}

/** The checklist's message: for the whole list, or the first step's (rows are not renumbered). */
export function stepsError(error: unknown): { readonly message?: string | undefined } | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { message?: string; root?: { message?: string } } & Record<
    string,
    unknown
  >;
  if (typeof record.message === "string") return { message: record.message };
  if (record.root?.message) return { message: record.root.message };
  for (const value of Object.values(record)) {
    const label = (value as { label?: { message?: string } } | undefined)?.label;
    if (label?.message) return { message: label.message };
  }
  return undefined;
}

export interface ChoreFormProps {
  readonly defaults: ChoreFormInput;
  readonly categories: readonly { readonly id: string; readonly name: string }[];
  readonly members: readonly MemberOption[];
  readonly today: string;
  readonly busy: boolean;
  readonly onSubmit: (values: ChoreFormOutput) => void;
  readonly onCancel?: () => void;
  readonly submitLabel: string;
  readonly dateFormat: DateFormat;
}

/**
 * A new chore's fields (S20): title, plain-text instructions, category, estimate, checklist, when
 * (once on a date, or repeating from a first date: never before today), and who it is for. A
 * rotation shows whose turn the next dates are before saving. The server validates everything
 * again.
 */
export function ChoreForm({
  defaults,
  categories,
  members,
  today,
  busy,
  onSubmit,
  onCancel,
  submitLabel,
  dateFormat,
}: ChoreFormProps) {
  const t = useTranslations("Chores");
  const hydrated = useHydrated();
  const message = useChoreFieldMessage();
  const form = useForm<ChoreFormInput, unknown, ChoreFormParsed>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults,
  });
  const errors = form.formState.errors;
  const date = useWatch({ control: form.control, name: "date" });
  const repeat = useWatch({ control: form.control, name: "repeat" });
  const assignment = useWatch({ control: form.control, name: "assignment" });
  const recurring = repeat.frequency !== "none";
  useEffect(() => {
    form.setFocus("title");
  }, [form]);
  // A rotation needs a repeating schedule; a one-off chore drops back to the members chosen.
  useEffect(() => {
    if (!recurring && assignment.mode === "rotating") {
      form.setValue("assignment", { mode: "fixed", members: assignment.members });
    }
  }, [recurring, assignment, form]);
  const nameOf = (id: string) => {
    const member = members.find((option) => option.id === id);
    return member?.isSelf ? t("personYou") : (member?.name ?? t("personUnnamed"));
  };
  const rule = recurring ? draftRule(repeat, date || null) : null;
  const rotationFrom = date && date > today ? date : today;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          onSubmit(outputOf(values));
        })(event);
      }}
      className="flex flex-col gap-4"
      data-testid="new-chore-form"
    >
      <TextField
        label={t("fieldTitle")}
        required
        autoComplete="off"
        maxLength={CHORE_LIMITS.title * 2}
        error={message(errors.title)}
        {...form.register("title")}
      />
      <TextArea
        label={t("fieldInstructions")}
        rows={3}
        error={message(errors.instructions)}
        {...form.register("instructions")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label={t("fieldCategory")}
          options={[
            { value: "", label: t("uncategorized") },
            ...categories.map((category) => ({ value: category.id, label: category.name })),
          ]}
          {...form.register("categoryId")}
        />
        <TextField
          type="number"
          inputMode="numeric"
          min={1}
          max={CHORE_LIMITS.minutes}
          label={t("fieldMinutes")}
          description={t("fieldMinutesHelp")}
          error={message(errors.minutes)}
          {...form.register("minutes")}
        />
      </div>
      <Checkbox
        label={t("fieldRequiresApproval")}
        description={t("fieldRequiresApprovalHelp")}
        data-testid="chore-requires-approval"
        {...form.register("requiresApproval")}
      />
      <TextField
        type="date"
        label={recurring ? t("fieldFirstDate") : t("fieldDueDate")}
        {...(recurring ? { description: t("fieldFirstDateHelp") } : {})}
        error={message(errors.date)}
        className="max-w-60"
        {...form.register("date")}
      />
      <Controller
        control={form.control}
        name="repeat"
        render={({ field }) => {
          const repeatErrors = errors.repeat;
          return (
            <RepeatFields
              value={field.value}
              onChange={field.onChange}
              startsOn={date || null}
              errors={{
                interval: repeatErrors?.interval?.message,
                weekdays: repeatErrors?.weekdays?.message ?? repeatErrors?.weekdays?.root?.message,
                endsOn: repeatErrors?.endsOn?.message,
                count: repeatErrors?.count?.message,
              }}
              dateFormat={dateFormat}
              allowNone
            />
          );
        }}
      />
      <Controller
        control={form.control}
        name="assignment"
        render={({ field }) => (
          <AssignmentEditor
            value={field.value}
            onChange={field.onChange}
            members={members}
            allowRotation={recurring}
            error={message(errors.assignment)}
          />
        )}
      />
      {assignment.mode === "rotating" ? (
        <RotationPreview
          rule={rule}
          rotationFrom={rotationFrom}
          order={assignment.members}
          nameOf={nameOf}
          dateFormat={dateFormat}
        />
      ) : null}
      <Controller
        control={form.control}
        name="steps"
        render={({ field }) => (
          <StepsEditor
            value={field.value}
            onChange={field.onChange}
            error={message(stepsError(errors.steps))}
          />
        )}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!hydrated} loading={busy} data-testid="chore-submit">
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
