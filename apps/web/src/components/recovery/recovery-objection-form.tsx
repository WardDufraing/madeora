"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { TextArea } from "@/components/ui/text-area";
import { useHydrated } from "@/components/ui/use-hydrated";
import { objectToRecovery, type RecoveryActionError } from "@/recovery/api";
import {
  reasonLimits,
  recoveryObjectionSchema,
  type RecoveryObjectionInput,
} from "@/recovery/schema";

import { RecoveryFailureAlert, useRecoveryFieldError } from "./recovery-failure-alert";

/**
 * Object to the open recovery request about this Home (S12b). The request pauses until Madeora
 * staff look at it; the reason goes to staff only.
 */
export function RecoveryObjectionForm({ homeId }: { readonly homeId: string }) {
  const t = useTranslations("Recovery");
  const router = useRouter();
  const hydrated = useHydrated();
  const fieldError = useRecoveryFieldError();
  const form = useForm<RecoveryObjectionInput>({
    resolver: zodResolver(recoveryObjectionSchema),
    defaultValues: { reason: "" },
  });

  const mutation = useMutation<undefined, RecoveryActionError, RecoveryObjectionInput>({
    mutationFn: async (values) => {
      await objectToRecovery(homeId, values);
      return undefined;
    },
    onSuccess: () => {
      router.replace(`/homes/${homeId}/recovery?objected=1`, { scroll: false });
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
        label={t("objectionLabel")}
        description={t("objectionHint")}
        required
        maxLength={reasonLimits.max}
        error={fieldError(form.formState.errors.reason?.message, reasonLimits)}
        {...form.register("reason")}
      />
      <div>
        <Button type="submit" disabled={!hydrated} loading={mutation.isPending}>
          {t("objectionSubmit")}
        </Button>
      </div>
    </form>
  );
}
