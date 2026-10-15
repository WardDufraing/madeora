"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { TextArea } from "@/components/ui/text-area";
import { useHydrated } from "@/components/ui/use-hydrated";
import { appealRecovery, type RecoveryActionError } from "@/recovery/api";
import { appealLimits, recoveryAppealSchema, type RecoveryAppealInput } from "@/recovery/schema";

import { RecoveryFailureAlert, useRecoveryFieldError } from "./recovery-failure-alert";

/**
 * A former Owner appeals a completed recovery (S12b). Staff review it; nothing changes on its own.
 */
export function RecoveryAppealForm({
  recoveryId,
  homeName,
}: {
  readonly recoveryId: string;
  readonly homeName: string;
}) {
  const t = useTranslations("Recovery");
  const router = useRouter();
  const hydrated = useHydrated();
  const fieldError = useRecoveryFieldError();
  const form = useForm<RecoveryAppealInput>({
    resolver: zodResolver(recoveryAppealSchema),
    defaultValues: { reason: "" },
  });
  const mutation = useMutation<undefined, RecoveryActionError, RecoveryAppealInput>({
    mutationFn: async (values) => {
      await appealRecovery(recoveryId, values);
      return undefined;
    },
    onSuccess: () => {
      router.replace("/settings/recoveries?appealed=1", { scroll: false });
      router.refresh();
    },
  });
  const onSubmit = form.handleSubmit((values) => {
    if (!mutation.isPending) mutation.mutate(values);
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
      <RecoveryFailureAlert failure={mutation.error?.failure ?? null} />
      <TextArea
        label={t("appealLabel", { home: homeName })}
        description={t("appealHint")}
        required
        maxLength={appealLimits.max}
        error={fieldError(form.formState.errors.reason?.message, appealLimits)}
        {...form.register("reason")}
      />
      <div>
        <Button type="submit" disabled={!hydrated} loading={mutation.isPending}>
          {t("appealSubmit")}
        </Button>
      </div>
    </form>
  );
}
