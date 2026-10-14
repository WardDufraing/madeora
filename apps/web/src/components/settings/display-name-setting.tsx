"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameSchema,
  type DisplayNameError,
} from "@/preferences/schema";

import { SaveFailureAlert } from "./save-failure";
import { useSavePreferences } from "./use-save-preferences";

const formSchema = z.object({ displayName: displayNameSchema });
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

export interface DisplayNameSettingProps {
  readonly initialName: string | null;
}

/**
 * The account's global display name, used on the personal dashboard and, later, in every Home
 * that has no Home-specific name for this person. Optional: saving an empty field removes it.
 */
export function DisplayNameSetting({ initialName }: DisplayNameSettingProps) {
  const t = useTranslations("Settings");
  const hydrated = useHydrated();
  const [saved, setSaved] = useState(false);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { displayName: initialName ?? "" },
  });
  const { mutation, saving, failure } = useSavePreferences((preferences) => {
    form.reset({ displayName: preferences.displayName ?? "" });
    setSaved(true);
  });
  const error = form.formState.errors.displayName?.message as DisplayNameError | undefined;

  // Read during render, so React Hook Form tracks whether anything was changed.
  const { isDirty } = form.formState;

  const onSubmit = form.handleSubmit((values) => {
    setSaved(false);
    // Unchanged: send nothing, so a page left open never undoes a change made on another device.
    if (!isDirty) return;
    mutation.mutate({ displayName: values.displayName });
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
      <TextField
        label={t("displayName")}
        description={t("displayNameHint", { max: DISPLAY_NAME_MAX_LENGTH })}
        autoComplete="nickname"
        dir="auto"
        maxLength={DISPLAY_NAME_MAX_LENGTH * 2}
        error={
          error === "displayNameTooLong"
            ? t("displayNameTooLong", { max: DISPLAY_NAME_MAX_LENGTH })
            : error === "displayNameInvalid"
              ? t("displayNameInvalid")
              : undefined
        }
        {...form.register("displayName", {
          onChange: () => {
            setSaved(false);
          },
        })}
      />
      <SaveFailureAlert failure={failure} />
      {saved && !mutation.isPending ? (
        <FormAlert tone="success" announce>
          {t("displayNameSaved")}
        </FormAlert>
      ) : null}
      <div>
        <Button type="submit" disabled={!hydrated} loading={saving}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
