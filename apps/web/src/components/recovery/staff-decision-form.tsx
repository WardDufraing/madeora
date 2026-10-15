"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { Button } from "@/components/ui/button";
import { TextArea } from "@/components/ui/text-area";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  decideRecovery,
  type RecoveryActionError,
  type StaffDecisionResponse,
} from "@/recovery/api";
import {
  formerOwnerOutcomes,
  staffActions,
  staffDecisionSchema,
  staffNotesLimits,
  type StaffAction,
  type StaffDecisionInput,
} from "@/recovery/schema";

import { RecoveryFailureAlert, useRecoveryFieldError } from "./recovery-failure-alert";

// The form always has an outcome chosen; it is sent only with an approval.
const formSchema = z
  .object({
    action: z.enum(staffActions),
    notes: z.string(),
    formerOwnerOutcome: z.enum(formerOwnerOutcomes),
  })
  .transform((values) => ({
    ...values,
    formerOwnerOutcome: values.action === "approve" ? values.formerOwnerOutcome : null,
  }))
  .pipe(staffDecisionSchema);
type FormValues = z.input<typeof formSchema>;

const actionKey = {
  start_review: "staffActionStartReview",
  approve: "staffActionApprove",
  pause: "staffActionPause",
  resume: "staffActionResume",
  reject: "staffActionReject",
} as const satisfies Record<StaffAction, string>;

/**
 * Madeora staff act on a recovery case (S12b; architecture.md §43). Only the actions that fit the
 * case's state are offered; the database checks again, and refuses unless the staff member signed
 * in within the last 15 minutes. Approving asks what happens to the former Owner.
 */
export function StaffDecisionForm({
  recoveryId,
  actions,
}: {
  readonly recoveryId: string;
  /** The actions the case's current state allows. */
  readonly actions: readonly StaffAction[];
}) {
  const t = useTranslations("Recovery");
  const router = useRouter();
  const hydrated = useHydrated();
  const fieldError = useRecoveryFieldError();
  const [result, setResult] = useState<StaffDecisionResponse | null>(null);
  const form = useForm<FormValues, unknown, StaffDecisionInput>({
    resolver: zodResolver(formSchema),
    defaultValues: { action: actions[0] ?? "reject", notes: "", formerOwnerOutcome: "member" },
  });
  const action = useWatch({ control: form.control, name: "action" });
  // After a decision the page refreshes with the case's new state: select the first action that
  // still fits, keeping the confirmation above (a remount would drop it).
  const firstAction = actions[0];
  const offered = actions.join(",");
  useEffect(() => {
    if (firstAction && !offered.split(",").includes(form.getValues("action"))) {
      form.setValue("action", firstAction);
    }
  }, [firstAction, offered, form]);

  const mutation = useMutation<StaffDecisionResponse, RecoveryActionError, StaffDecisionInput>({
    mutationFn: (values) => decideRecovery(recoveryId, values),
    onSuccess: (response) => {
      setResult(response);
      form.reset({ ...form.getValues(), notes: "" });
      router.refresh();
    },
  });
  const onSubmit = form.handleSubmit((values) => {
    if (mutation.isPending) return;
    setResult(null);
    mutation.mutate(values);
  });

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-4"
    >
      {result ? (
        <FormAlert tone="success" announce>
          {t("staffDecided")} {t("staffNotified")}
        </FormAlert>
      ) : null}
      <RecoveryFailureAlert failure={mutation.error?.failure ?? null} />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-2 text-body font-medium text-fg">{t("staffActionLegend")}</legend>
        {actions.map((value) => (
          <RadioOption
            key={value}
            value={value}
            label={t(actionKey[value])}
            {...form.register("action")}
          />
        ))}
      </fieldset>
      {action === "approve" ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-2 text-body font-medium text-fg">{t("staffOutcomeLegend")}</legend>
          <RadioOption
            value="member"
            label={t("staffOutcomeMember")}
            {...form.register("formerOwnerOutcome")}
          />
          <RadioOption
            value="removed"
            label={t("staffOutcomeRemoved")}
            {...form.register("formerOwnerOutcome")}
          />
        </fieldset>
      ) : null}
      <TextArea
        label={t("staffNotesLabel")}
        description={t("staffNotesHint")}
        maxLength={staffNotesLimits.max}
        error={fieldError(form.formState.errors.notes?.message, staffNotesLimits)}
        {...form.register("notes")}
      />
      <div>
        <Button type="submit" disabled={!hydrated} loading={mutation.isPending}>
          {t("staffDecide")}
        </Button>
      </div>
    </form>
  );
}
