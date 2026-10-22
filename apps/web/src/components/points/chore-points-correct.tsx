"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { useChoreMutation } from "@/components/chores/use-chore-mutation";
import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextArea } from "@/components/ui/text-area";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { CHORE_OCCURRENCES_ENDPOINT, sendChoreRequest } from "@/chores/api";
import type { ChorePoints, ChorePointsChange } from "@/points/api";
import type { ChorePointsInput } from "@/points/chore-points";
import { pointsNoteSchema } from "@/points/schema";
import type { MemberNames } from "@/tasks/format";

import { PointsChangeView } from "./points-change";
import { chorePointsDraftSchema, PointsFields, pointsDraft } from "./points-fields";

const formSchema = z.object({ setting: chorePointsDraftSchema, reason: pointsNoteSchema });
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

interface PointsResult {
  readonly outcome: "preview" | "saved" | "unchanged";
  readonly impact: {
    readonly points: number;
    readonly previousPoints: number;
    readonly change: ChorePointsChange | null;
  } | null;
}

/**
 * Correcting one occurrence's points (S23; spec "unless an authorized user explicitly corrects an
 * eligible occurrence"): chore managers; a completed occurrence's awarded points also need the
 * right to manage points and a reason. The database answers the preview first (who gains or loses
 * how many points); the person confirms exactly what they saw.
 */
export function ChorePointsCorrect({
  occurrenceId,
  revision,
  points,
  completed,
  names,
}: {
  readonly occurrenceId: string;
  readonly revision: number;
  readonly points: Pick<ChorePoints, "points" | "latePolicy" | "latePoints">;
  readonly completed: boolean;
  readonly names: MemberNames;
}) {
  const t = useTranslations("Points");
  const texts = useChoreTexts(names);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{
    body: { setting: ChorePointsInput; reason: string | null };
    result: PointsResult;
  } | null>(null);
  const [reasonMissing, setReasonMissing] = useState(false);
  const { announce, region } = useAnnouncer();
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { setting: pointsDraft(points), reason: "" },
  });
  const policy = useWatch({ control: form.control, name: "setting.latePolicy" });
  const mutation = useChoreMutation(
    `chore-occurrence:${occurrenceId}`,
    ({
      body,
      dryRun,
    }: {
      body: { setting: ChorePointsInput; reason: string | null };
      dryRun: boolean;
    }) =>
      sendChoreRequest<PointsResult>(
        "PUT",
        `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}/points`,
        {
          expectedRevision: revision,
          ...body,
          dryRun,
        },
      ),
    (result, { body, dryRun }) => {
      if (dryRun && result.outcome === "preview") {
        setPreview({ body, result });
        return;
      }
      setOpen(false);
      setPreview(null);
      announce(result.outcome === "unchanged" ? t("pointsUnchanged") : t("pointsCorrected"));
    },
    { refresh: (result, { dryRun }) => !dryRun || result.outcome !== "preview" },
  );
  const close = () => {
    setOpen(false);
    setPreview(null);
    mutation.reset();
  };
  const errors = form.formState.errors;

  return (
    <>
      {region}
      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            form.reset({ setting: pointsDraft(points), reason: "" });
            setPreview(null);
            setReasonMissing(false);
            mutation.reset();
            setOpen(true);
          }}
          data-testid="chore-points-correct-open"
        >
          {t("correctPoints")}
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={close}
        title={t("correctPointsTitle")}
        description={completed ? t("correctPointsCompletedBody") : t("correctPointsOpenBody")}
        closeLabel={t("close")}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {t("cancel")}
            </Button>
            {preview ? (
              <Button
                loading={mutation.busy}
                onClick={() => {
                  mutation.mutate({ body: preview.body, dryRun: false });
                }}
                data-testid="chore-points-correct-confirm"
              >
                {t("confirm")}
              </Button>
            ) : (
              <Button
                loading={mutation.busy}
                onClick={() => {
                  void form.handleSubmit((values) => {
                    if (completed && values.reason === null) {
                      setReasonMissing(true);
                      return;
                    }
                    setReasonMissing(false);
                    mutation.mutate({
                      body: { setting: values.setting, reason: values.reason },
                      dryRun: true,
                    });
                  })();
                }}
                data-testid="chore-points-correct-next"
              >
                {t("preview")}
              </Button>
            )}
          </>
        }
      >
        <div
          className="flex flex-col gap-4"
          onChange={() => {
            setPreview(null);
          }}
        >
          <PointsFields
            register={{
              points: form.register("setting.points"),
              latePolicy: form.register("setting.latePolicy"),
              latePoints: form.register("setting.latePoints"),
            }}
            policy={policy}
            errors={{ points: errors.setting?.points, latePoints: errors.setting?.latePoints }}
          />
          <TextArea
            label={completed ? t("fieldReasonRequired") : t("fieldReasonOptional")}
            rows={2}
            error={
              reasonMissing
                ? t("fieldReasonMissing")
                : errors.reason
                  ? t("fieldReasonInvalid")
                  : undefined
            }
            data-testid="chore-points-reason"
            {...form.register("reason")}
          />
          {preview ? (
            preview.result.impact?.change ? (
              <PointsChangeView
                change={preview.result.impact.change}
                person={texts.person}
                testId="chore-points-impact"
              />
            ) : (
              <p className="text-body text-fg" data-testid="chore-points-impact">
                {t("noAwardChange")}
              </p>
            )
          ) : null}
          {mutation.error ? (
            <FormAlert tone="error" announce>
              {texts.failure(mutation.error.failure, mutation.error.detail)}
            </FormAlert>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
