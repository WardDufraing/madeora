"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import {
  chorePointsDraftSchema,
  noPointsDraft,
  PointsFields,
  pointsDraft,
} from "@/components/points/points-fields";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORES_ENDPOINT,
  sendChoreRequest,
  type ChoreOccurrenceDetail,
  type RevisionResponse,
} from "@/chores/api";
import { CHORE_LIMITS, choreTitleSchema, instructionsSchema } from "@/chores/schema";
import { noMembers } from "@/tasks/format";

import { useChoreFieldMessage } from "./chore-form";
import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

const formSchema = z.object({
  title: choreTitleSchema,
  instructions: instructionsSchema,
  categoryId: z.string(),
  requiresApproval: z.boolean(),
  points: chorePointsDraftSchema,
});
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

export interface ChoreFieldsEditProps {
  readonly chore: ChoreOccurrenceDetail["chore"];
  /** Active categories; an archived one the chore has stays offered. */
  readonly categories: readonly { readonly id: string; readonly name: string }[];
  /** The chore's points setting (S23); new occurrences take it. */
  readonly points?: {
    readonly points: number;
    readonly latePolicy: "full" | "reduced" | "zero";
    readonly latePoints: number | null;
  };
}

/**
 * Editing the chore itself (S20, chore managers): title, instructions, category and whether
 * completions need approval belong to the chore, so no scope is asked (approval applies to
 * completions submitted after the change). Open occurrences show the change at once; completed and skipped ones
 * keep what they were closed under.
 */
export function ChoreFieldsEdit({ chore, categories, points }: ChoreFieldsEditProps) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const message = useChoreFieldMessage();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: chore.title,
      instructions: chore.instructions ?? "",
      categoryId: chore.category?.id ?? "",
      requiresApproval: chore.requiresApproval,
      points: points ? pointsDraft(points) : noPointsDraft,
    },
  });
  const latePolicy = useWatch({ control: form.control, name: "points.latePolicy" });
  const mutation = useChoreMutation(
    `chore:${chore.id}`,
    (input: FormOutput) =>
      sendChoreRequest<RevisionResponse>("PATCH", `${CHORES_ENDPOINT}/${chore.id}`, {
        expectedRevision: chore.revision,
        title: input.title,
        instructions: input.instructions,
        categoryId: input.categoryId === "" ? null : input.categoryId,
        requiresApproval: input.requiresApproval,
        // Without the current setting (it could not be read) the points are left as they are.
        ...(points ? { points: input.points } : {}),
      }),
    () => {
      announce(t("announceSaved"));
      setOpen(false);
      requestAnimationFrame(() => opener.current?.focus());
    },
  );
  const options = [
    { value: "", label: t("uncategorized") },
    ...(chore.category && !categories.some((category) => category.id === chore.category?.id)
      ? [{ value: chore.category.id, label: t("archivedCategory", { name: chore.category.name }) }]
      : []),
    ...categories.map((category) => ({ value: category.id, label: category.name })),
  ];

  return (
    <HydrationGate>
      {region}
      {!open ? (
        <div>
          <Button
            ref={opener}
            variant="secondary"
            onClick={() => {
              form.reset();
              mutation.reset();
              setOpen(true);
            }}
            data-testid="chore-fields-edit"
          >
            {t("editChore")}
          </Button>
        </div>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            void form.handleSubmit((values) => {
              mutation.mutate(values);
            })(event);
          }}
          className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
          data-testid="chore-fields-form"
        >
          <p className="text-helper text-fg-muted">{t("editChoreHelp")}</p>
          <TextField
            label={t("fieldTitle")}
            required
            autoComplete="off"
            maxLength={CHORE_LIMITS.title * 2}
            error={message(form.formState.errors.title)}
            {...form.register("title")}
          />
          <TextArea
            label={t("fieldInstructions")}
            rows={3}
            error={message(form.formState.errors.instructions)}
            {...form.register("instructions")}
          />
          <SelectField
            label={t("fieldCategory")}
            options={options}
            {...form.register("categoryId")}
          />
          <Checkbox
            label={t("fieldRequiresApproval")}
            description={t("fieldRequiresApprovalEditHelp")}
            data-testid="chore-requires-approval"
            {...form.register("requiresApproval")}
          />
          {points ? (
            <PointsFields
              register={{
                points: form.register("points.points"),
                latePolicy: form.register("points.latePolicy"),
                latePoints: form.register("points.latePoints"),
              }}
              policy={latePolicy}
              errors={{
                points: form.formState.errors.points?.points,
                latePoints: form.formState.errors.points?.latePoints,
              }}
              help={t("pointsEditHelp")}
            />
          ) : null}
          {mutation.error ? (
            <FormAlert tone="error" announce>
              {texts.failure(mutation.error.failure)}
            </FormAlert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={mutation.busy}>
              {t("save")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
                requestAnimationFrame(() => opener.current?.focus());
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </form>
      )}
    </HydrationGate>
  );
}
