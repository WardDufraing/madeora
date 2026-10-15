"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { TextArea } from "@/components/ui/text-area";
import { useHydrated } from "@/components/ui/use-hydrated";
import { requestRecovery, type RecoveryActionError } from "@/recovery/api";
import {
  recoveryStatementSchema,
  statementLimits,
  type RecoveryStatementValues,
} from "@/recovery/schema";

import { RecoveryFailureAlert, useRecoveryFieldError } from "./recovery-failure-alert";

/**
 * Ask Madeora staff to review an ownership recovery (S12b). The statement goes to staff only. One
 * request id per form, so a retried submit returns the same request instead of a second one.
 */
export function RecoveryRequestForm({ homeId }: { readonly homeId: string }) {
  const t = useTranslations("Recovery");
  const router = useRouter();
  const hydrated = useHydrated();
  const fieldError = useRecoveryFieldError();
  const [requestId] = useState(() => crypto.randomUUID());
  const form = useForm<RecoveryStatementValues>({
    resolver: zodResolver(recoveryStatementSchema),
    defaultValues: { statement: "" },
  });

  const mutation = useMutation<unknown, RecoveryActionError, RecoveryStatementValues>({
    mutationFn: (values) => requestRecovery(homeId, { ...values, requestId }),
    onSuccess: () => {
      router.replace(`/homes/${homeId}/recovery?requested=1`, { scroll: false });
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
        label={t("statementLabel")}
        description={t("statementHint")}
        required
        rows={8}
        maxLength={statementLimits.max}
        error={fieldError(form.formState.errors.statement?.message, statementLimits)}
        {...form.register("statement")}
      />
      <div>
        <Button type="submit" disabled={!hydrated} loading={mutation.isPending}>
          {t("requestSubmit")}
        </Button>
      </div>
    </form>
  );
}
