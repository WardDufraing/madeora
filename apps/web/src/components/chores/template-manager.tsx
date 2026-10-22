"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import {
  chorePointsDraftSchema,
  noPointsDraft,
  PointsFields,
  pointsDraft,
} from "@/components/points/points-fields";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { LabelChip } from "@/components/tasks/label-chip";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_TEMPLATES_ENDPOINT,
  sendChoreRequest,
  type ChoreTemplate,
  type RevisionResponse,
} from "@/chores/api";
import { CHORE_LIMITS, choreTitleSchema, instructionsSchema } from "@/chores/schema";
import { noMembers } from "@/tasks/format";

import {
  minutesDraftSchema,
  stepDraftsSchema,
  stepsError,
  useChoreFieldMessage,
} from "./chore-form";
import { StepsEditor, type StepDraft } from "./steps-editor";
import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

const formSchema = z.object({
  title: choreTitleSchema,
  instructions: instructionsSchema,
  categoryId: z.string(),
  minutes: minutesDraftSchema,
  steps: stepDraftsSchema,
  points: chorePointsDraftSchema,
});
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

/** The request fields of a template from the form. */
function fieldsOf(values: FormOutput) {
  return {
    title: values.title,
    instructions: values.instructions,
    categoryId: values.categoryId === "" ? null : values.categoryId,
    minutes: values.minutes,
    steps: values.steps.map(({ label, mandatory }) => ({ label, mandatory })),
    points: values.points,
  };
}

/** A template as the form edits it; its checklist rows get fresh keys. */
export function templateDraft(
  template: Pick<
    ChoreTemplate,
    "title" | "instructions" | "category" | "minutes" | "steps" | "points"
  >,
  usableCategory: (id: string) => boolean,
): FormInput {
  return {
    title: template.title,
    instructions: template.instructions ?? "",
    categoryId:
      template.category && usableCategory(template.category.id) ? template.category.id : "",
    minutes: template.minutes === null ? "" : String(template.minutes),
    steps: template.steps.map((step): StepDraft => ({
      key: crypto.randomUUID(),
      id: null,
      label: step.label,
      mandatory: step.mandatory,
    })),
    points: pointsDraft(template.points),
  };
}

const emptyTemplate: FormInput = {
  title: "",
  instructions: "",
  categoryId: "",
  minutes: "",
  steps: [],
  points: noPointsDraft,
};

interface TemplateFormProps {
  readonly defaults: FormInput;
  /** Active categories, plus the template's archived one while it keeps it. */
  readonly categories: readonly { readonly value: string; readonly label: string }[];
  readonly busy: boolean;
  readonly submitLabel: string;
  readonly onSubmit: (values: FormOutput) => void;
  readonly onCancel: () => void;
}

function TemplateForm({
  defaults,
  categories,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: TemplateFormProps) {
  const t = useTranslations("Chores");
  const message = useChoreFieldMessage();
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults,
  });
  const errors = form.formState.errors;
  const latePolicy = useWatch({ control: form.control, name: "points.latePolicy" });
  return (
    <form
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit(onSubmit)(event);
      }}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      data-testid="chore-template-form"
    >
      <TextField
        label={t("fieldTemplateTitle")}
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
          options={[{ value: "", label: t("uncategorized") }, ...categories]}
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
      <PointsFields
        register={{
          points: form.register("points.points"),
          latePolicy: form.register("points.latePolicy"),
          latePoints: form.register("points.latePoints"),
        }}
        policy={latePolicy}
        errors={{ points: errors.points?.points, latePoints: errors.points?.latePoints }}
        help={t("pointsTemplateHelp")}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} data-testid="chore-template-save">
          {submitLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

type Editing =
  | { readonly kind: "new"; readonly defaults: FormInput }
  | { readonly kind: "edit"; readonly template: ChoreTemplate };

/**
 * A Home's chore templates (S20, chore managers; spec "Confirmed reusable chore templates"): add,
 * edit, duplicate (a new template prefilled from this one), retire (no longer offered for new
 * chores) and reinstate. A template holds a title, instructions, a category, an estimate and a
 * checklist, never assignees or a schedule; chores made from it are independent copies, so a
 * change here never reaches them.
 */
export function TemplateManager({
  homeId,
  templates,
  categories,
}: {
  readonly homeId: string;
  readonly templates: readonly ChoreTemplate[];
  /** Active categories. */
  readonly categories: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const { announce, region } = useAnnouncer();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const opener = useRef<HTMLButtonElement>(null);
  const usable = (id: string) => categories.some((category) => category.id === id);
  const close = () => {
    setEditing(null);
    requestAnimationFrame(() => opener.current?.focus());
  };

  const create = useChoreMutation(
    `chore-template-create:${draftId}`,
    (values: FormOutput) =>
      sendChoreRequest<RevisionResponse>("POST", CHORE_TEMPLATES_ENDPOINT, {
        id: draftId,
        homeId,
        ...fieldsOf(values),
      }),
    () => {
      announce(t("announceTemplateAdded"));
      setDraftId(crypto.randomUUID());
      close();
    },
  );
  const update = useChoreMutation(
    `chore-templates:${homeId}`,
    (input: { template: ChoreTemplate; fields: ReturnType<typeof fieldsOf>; retired?: boolean }) =>
      sendChoreRequest<RevisionResponse>(
        "PATCH",
        `${CHORE_TEMPLATES_ENDPOINT}/${input.template.id}`,
        {
          expectedRevision: input.template.revision,
          ...input.fields,
          ...(input.retired === undefined ? {} : { retired: input.retired }),
        },
      ),
    (_, input) => {
      announce(
        input.retired === undefined
          ? t("announceSaved")
          : input.retired
            ? t("announceTemplateRetired")
            : t("announceTemplateReinstated"),
      );
      if (input.retired === undefined) close();
    },
  );
  const error = editing ? null : (update.error ?? create.error);
  const active = templates.filter((template) => !template.retired);
  const retired = templates.filter((template) => template.retired);
  const categoryOptions = (keep: ChoreTemplate["category"]) => [
    ...(keep && !usable(keep.id)
      ? [{ value: keep.id, label: t("archivedCategory", { name: keep.name }) }]
      : []),
    ...categories.map((category) => ({ value: category.id, label: category.name })),
  ];
  const keepFields = (template: ChoreTemplate) => ({
    title: template.title,
    instructions: template.instructions,
    categoryId: template.category?.id ?? null,
    minutes: template.minutes,
    steps: template.steps.map(({ label, mandatory }) => ({ label, mandatory })),
    points: template.points,
  });

  const row = (template: ChoreTemplate) => (
    <li key={template.id} className="flex flex-col gap-2 p-3" data-testid="chore-template">
      {editing?.kind === "edit" && editing.template.id === template.id ? (
        <>
          <TemplateForm
            defaults={templateDraft(template, () => true)}
            categories={categoryOptions(template.category)}
            busy={update.busy}
            submitLabel={t("save")}
            onSubmit={(values) => {
              update.mutate({ template, fields: fieldsOf(values) });
            }}
            onCancel={close}
          />
          {update.error ? (
            <FormAlert tone="error" announce>
              {texts.failure(update.error.failure)}
            </FormAlert>
          ) : null}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <bdi className="text-body font-semibold text-fg">{template.title}</bdi>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-helper text-fg-muted">
              {template.category ? (
                <LabelChip name={template.category.name} color={template.category.color} />
              ) : (
                <span>{t("uncategorized")}</span>
              )}
              {template.minutes !== null ? (
                <span>{t("minutes", { count: template.minutes })}</span>
              ) : null}
              <span>
                {t("templateSteps", {
                  count: template.steps.length,
                  mandatory: template.steps.filter((step) => step.mandatory).length,
                })}
              </span>
            </p>
          </div>
          <span className="flex flex-wrap gap-1">
            {!template.retired ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    update.reset();
                    setEditing({ kind: "edit", template });
                  }}
                  aria-label={t("editTemplate", { title: template.title })}
                >
                  {t("edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    create.reset();
                    setEditing({
                      kind: "new",
                      defaults: {
                        ...templateDraft(template, usable),
                        title: t("templateCopyTitle", { title: template.title }),
                      },
                    });
                  }}
                  aria-label={t("duplicateTemplate", { title: template.title })}
                  data-testid="chore-template-duplicate"
                >
                  {t("duplicate")}
                </Button>
              </>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              loading={update.busy}
              onClick={() => {
                update.mutate({
                  template,
                  fields: keepFields(template),
                  retired: !template.retired,
                });
              }}
              aria-label={
                template.retired
                  ? t("reinstateTemplate", { title: template.title })
                  : t("retireTemplate", { title: template.title })
              }
              data-testid="chore-template-retire"
            >
              {template.retired ? t("reinstate") : t("retire")}
            </Button>
          </span>
        </div>
      )}
    </li>
  );

  return (
    <section aria-labelledby="chore-templates-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="chore-templates-heading" className="text-section-title font-semibold text-fg">
          {t("templatesHeading")}
        </h2>
        <p className="text-helper text-fg-muted">{t("templatesHelp")}</p>
        {editing?.kind === "new" ? (
          <>
            <TemplateForm
              defaults={editing.defaults}
              categories={categoryOptions(null)}
              busy={create.busy}
              submitLabel={t("addTemplate")}
              onSubmit={(values) => {
                create.mutate(values);
              }}
              onCancel={close}
            />
            {create.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(create.error.failure)}
              </FormAlert>
            ) : null}
          </>
        ) : (
          <div>
            <Button
              ref={opener}
              variant="secondary"
              disabled={templates.length >= CHORE_LIMITS.templates}
              onClick={() => {
                create.reset();
                setEditing({ kind: "new", defaults: emptyTemplate });
              }}
              data-testid="chore-template-new"
            >
              {t("newTemplate")}
            </Button>
          </div>
        )}
        {error ? (
          <FormAlert tone="error" announce>
            {texts.failure(error.failure)}
          </FormAlert>
        ) : null}
        {active.length > 0 ? (
          <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
            {active.map(row)}
          </ul>
        ) : (
          <p className="text-body text-fg-muted">{t("noTemplates")}</p>
        )}
        {retired.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-body font-medium text-fg">
              {t("retiredTemplates", { count: retired.length })}
            </summary>
            <ul className="mt-2 flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
              {retired.map(row)}
            </ul>
          </details>
        ) : null}
      </HydrationGate>
    </section>
  );
}
