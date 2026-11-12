"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { accentColorSchema, type AccentColor } from "@/accent/accent";
import { AccentPicker } from "@/components/accent/accent-picker";
import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { setChildPresentation } from "@/children/api";
import type { MemberActionError } from "@/members/manage-api";
import { DISPLAY_NAME_MAX_LENGTH, optionalNameSchema } from "@/preferences/schema";

const formSchema = z.object({ displayName: optionalNameSchema, accentColor: accentColorSchema });
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

/**
 * How the child appears in this Home (S41): a Home name and the identifying colour, managed by
 * either guardian, with a reset to a suggested colour (spec "Confirmed child-controlled accent
 * colors with guardian reset"; the child's own colour choice arrives with child sign-in, S42).
 */
export function ChildPresentationForm({
  homeId,
  membershipId,
  displayName,
  accentColor,
  suggestedColor,
}: {
  readonly homeId: string;
  readonly membershipId: string;
  readonly displayName: string | null;
  readonly accentColor: AccentColor;
  readonly suggestedColor: AccentColor;
}) {
  const t = useTranslations("Children");
  const tSettings = useTranslations("Settings");
  const router = useRouter();
  const hydrated = useHydrated();
  const [saved, setSaved] = useState(false);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { displayName: displayName ?? "", accentColor },
  });
  const mutation = useMutation<undefined, MemberActionError, FormOutput>({
    mutationFn: async (values) => {
      await setChildPresentation(homeId, membershipId, {
        displayName: values.displayName ?? "",
        accentColor: values.accentColor,
      });
      return undefined;
    },
    onSuccess: (_, values) => {
      setSaved(true);
      form.reset({ displayName: values.displayName ?? "", accentColor: values.accentColor });
      router.refresh();
    },
  });
  const submit = form.handleSubmit((values) => {
    setSaved(false);
    if (!mutation.isPending) mutation.mutate(values);
  });
  const nameError = form.formState.errors.displayName?.message;

  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-5"
      data-testid="child-presentation-form"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <TextField
        label={t("homeNameLabel")}
        description={t("homeNameHint", { max: DISPLAY_NAME_MAX_LENGTH })}
        dir="auto"
        autoComplete="off"
        maxLength={DISPLAY_NAME_MAX_LENGTH * 2}
        error={
          nameError === "displayNameTooLong"
            ? tSettings("displayNameTooLong", { max: DISPLAY_NAME_MAX_LENGTH })
            : nameError
              ? tSettings("displayNameInvalid")
              : undefined
        }
        {...form.register("displayName")}
      />
      <Controller
        control={form.control}
        name="accentColor"
        render={({ field }) => (
          <AccentPicker
            legend={t("colorLabel")}
            value={accentColorSchema.safeParse(field.value).data ?? accentColor}
            onChange={field.onChange}
            disabled={!hydrated}
          />
        )}
      />
      <MemberFailureAlert failure={mutation.error?.failure ?? null} />
      {saved && !mutation.isPending ? (
        <FormAlert tone="success" announce>
          {t("presentationSaved")}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!hydrated} loading={mutation.isPending}>
          {t("savePresentation")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!hydrated || mutation.isPending}
          onClick={() => {
            form.setValue("accentColor", suggestedColor, { shouldDirty: true });
            void submit();
          }}
        >
          {t("resetColor")}
        </Button>
      </div>
    </form>
  );
}
