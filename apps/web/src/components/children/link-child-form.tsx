"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import type { z } from "zod";

import { accentColorSchema, type AccentColor } from "@/accent/accent";
import { AccentPicker } from "@/components/accent/accent-picker";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { redeemChildLinkCode } from "@/children/api";
import { redeemLinkSchema } from "@/children/schema";
import type { MemberActionError } from "@/members/manage-api";

const formSchema = redeemLinkSchema;
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

/**
 * Link an existing child to this Home with the code their primary guardian in another Home gave
 * you (S41). You become the child's primary guardian here; nothing from the other Home is shown.
 */
export function LinkChildForm({
  homeId,
  suggestedColor,
}: {
  readonly homeId: string;
  readonly suggestedColor: AccentColor;
}) {
  const t = useTranslations("Children");
  const router = useRouter();
  const hydrated = useHydrated();
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { code: "", accentColor: suggestedColor },
  });
  const mutation = useMutation<{ readonly membershipId: string }, MemberActionError, FormOutput>({
    mutationFn: (values) => redeemChildLinkCode(homeId, values),
    onSuccess: ({ membershipId }) => {
      router.push(`/homes/${homeId}/children/${membershipId}?linked=1`);
      router.refresh();
    },
  });
  const codeError = form.formState.errors.code?.message;

  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-5"
      data-testid="link-child-form"
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          if (!mutation.isPending) mutation.mutate(values);
        })(event);
      }}
    >
      <TextField
        label={t("linkCodeLabel")}
        description={t("linkCodeFieldHint")}
        autoComplete="off"
        spellCheck={false}
        maxLength={64}
        error={codeError ? t("linkCodeInvalid") : undefined}
        {...form.register("code")}
      />
      <Controller
        control={form.control}
        name="accentColor"
        render={({ field }) => (
          <AccentPicker
            legend={t("colorLabel")}
            value={accentColorSchema.safeParse(field.value).data ?? suggestedColor}
            onChange={field.onChange}
            disabled={!hydrated}
          />
        )}
      />
      <p className="text-helper text-fg-muted">{t("linkBecomeGuardian")}</p>
      <MemberFailureAlert failure={mutation.error?.failure ?? null} />
      <div>
        <Button type="submit" disabled={!hydrated} loading={mutation.isPending}>
          {t("linkButton")}
        </Button>
      </div>
    </form>
  );
}
