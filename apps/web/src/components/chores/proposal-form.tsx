"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { ChoreStepTemplate } from "@/chores/api";
import {
  CHORE_LIMITS,
  choreTitleSchema,
  instructionsSchema,
  type StepInput,
} from "@/chores/schema";
import { dateOnlySchema } from "@/tasks/schema";

import {
  minutesDraftSchema,
  stepDraftsSchema,
  stepsError,
  useChoreFieldMessage,
} from "./chore-form";
import { newStep, StepsEditor, type StepDraft } from "./steps-editor";

const formSchema = z
  .object({
    title: choreTitleSchema,
    instructions: instructionsSchema,
    categoryId: z.string(),
    minutes: minutesDraftSchema,
    dueDate: z.union([z.literal(""), dateOnlySchema]),
    steps: stepDraftsSchema,
  })
  .refine((proposal) => proposal.dueDate !== "", {
    message: "dateRequired",
    path: ["dueDate"],
  });
type FormInput = z.input<typeof formSchema>;
type FormParsed = z.output<typeof formSchema>;

/** A proposal's fields as the API takes them (S21): a one-off unassigned chore. */
export interface ProposalFields {
  readonly title: string;
  readonly instructions: string | null;
  readonly categoryId: string | null;
  readonly minutes: number | null;
  readonly steps: StepInput[];
  readonly dueDate: string;
}

/** The form's starting values: empty for a new proposal, or a proposal's own for a review. */
export function proposalDefaults(
  today: string,
  from?: {
    readonly title: string;
    readonly instructions: string | null;
    readonly categoryId: string | null;
    readonly minutes: number | null;
    readonly steps: readonly ChoreStepTemplate[];
    readonly dueDate: string;
  },
): FormInput {
  return {
    title: from?.title ?? "",
    instructions: from?.instructions ?? "",
    categoryId: from?.categoryId ?? "",
    minutes: from?.minutes === null || from?.minutes === undefined ? "" : String(from.minutes),
    dueDate: from ? (from.dueDate < today ? today : from.dueDate) : today,
    steps: (from?.steps ?? []).map((step): StepDraft => ({
      ...newStep(),
      label: step.label,
      mandatory: step.mandatory,
    })),
  };
}

export interface ProposalFormProps {
  readonly defaults: FormInput;
  readonly categories: readonly { readonly id: string; readonly name: string }[];
  readonly today: string;
  readonly busy: boolean;
  readonly onSubmit: (values: ProposalFields) => void;
  readonly onCancel: () => void;
  readonly submitLabel: string;
  readonly testId: string;
}

/**
 * A proposed chore's fields (S21): title, instructions, category, estimate, checklist and the day
 * it is due (today up to a year ahead). The proposer fills it in; a chore manager reviewing it gets
 * the same form with the proposal's values to revise before approving. The server checks it again.
 */
export function ProposalForm({
  defaults,
  categories,
  today,
  busy,
  onSubmit,
  onCancel,
  submitLabel,
  testId,
}: ProposalFormProps) {
  const t = useTranslations("Chores");
  const hydrated = useHydrated();
  const message = useChoreFieldMessage();
  const form = useForm<FormInput, unknown, FormParsed>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults,
  });
  const errors = form.formState.errors;
  useEffect(() => {
    form.setFocus("title");
  }, [form]);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          onSubmit({
            title: values.title,
            instructions: values.instructions,
            categoryId: values.categoryId === "" ? null : values.categoryId,
            minutes: values.minutes,
            steps: values.steps.map(({ label, mandatory }) => ({ label, mandatory })),
            dueDate: values.dueDate,
          });
        })(event);
      }}
      className="flex flex-col gap-4"
      data-testid={testId}
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
      <TextField
        type="date"
        label={t("fieldDueDate")}
        min={today}
        error={message(errors.dueDate)}
        className="max-w-60"
        {...form.register("dueDate")}
      />
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
        <Button type="submit" disabled={!hydrated} loading={busy} data-testid={`${testId}-submit`}>
          {submitLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
