"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { TextArea } from "@/components/ui/text-area";
import { useHydrated } from "@/components/ui/use-hydrated";
import { closeRecoveryAppeal, type RecoveryActionError } from "@/recovery/api";
import {
  staffAppealCloseSchema,
  staffNotesLimits,
  type StaffAppealCloseInput,
} from "@/recovery/schema";

import { RecoveryFailureAlert, useRecoveryFieldError } from "./recovery-failure-alert";

/** Staff close an appeal with their note (S12b). Nothing in the Home changes. */
export function StaffCloseAppealForm({ appealId }: { readonly appealId: string }) {
  const t = useTranslations("Recovery");
  const router = useRouter();
  const hydrated = useHydrated();
  const fieldError = useRecoveryFieldError();
  const form = useForm<StaffAppealCloseInput>({
    resolver: zodResolver(staffAppealCloseSchema),
    defaultValues: { notes: "" },
  });
  const mutation = useMutation<undefined, RecoveryActionError, StaffAppealCloseInput>({
    mutationFn: async (values) => {
      await closeRecoveryAppeal(appealId, values);
      return undefined;
    },
    onSuccess: () => {
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
      className="flex flex-col gap-3"
    >
      <RecoveryFailureAlert failure={mutation.error?.failure ?? null} />
      <TextArea
        label={t("staffAppealNotesLabel")}
        required
        rows={3}
        maxLength={staffNotesLimits.max}
        error={fieldError(form.formState.errors.notes?.message, staffNotesLimits)}
        {...form.register("notes")}
      />
      <div>
        <Button type="submit" variant="secondary" disabled={!hydrated} loading={mutation.isPending}>
          {t("staffAppealClose")}
        </Button>
      </div>
    </form>
  );
}
