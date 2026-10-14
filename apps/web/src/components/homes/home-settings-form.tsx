"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import { updateHomeSettings, type HomeSaveError } from "@/homes/api";
import {
  homeNameSchema,
  homeTimeZoneSchema,
  type HomeFieldError,
  type HomeSettingsPatchInput,
} from "@/homes/schema";
import type { HomeSummary } from "@/homes/types";

import { HomeFields } from "./home-fields";
import { HomeSaveFailureAlert } from "./save-failure";

const formSchema = z.object({ name: homeNameSchema, timeZone: homeTimeZoneSchema });
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

export interface HomeSettingsFormProps {
  readonly home: HomeSummary;
  readonly timeZoneChoices: readonly string[];
}

/**
 * A Home's name and scheduling timezone, for people allowed to change them. The Home's id comes
 * from the page that rendered this form and is sent with every save, so switching to another Home
 * in another tab can never redirect the change (spec: unfinished operations keep their Home).
 */
export function HomeSettingsForm({ home, timeZoneChoices }: HomeSettingsFormProps) {
  const t = useTranslations("Homes");
  const hydrated = useHydrated();
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: home.name, timeZone: home.timeZone },
  });
  const mutation = useMutation<HomeSummary, HomeSaveError, HomeSettingsPatchInput>({
    mutationFn: (patch) => updateHomeSettings(home.id, patch),
    scope: { id: `home-settings:${home.id}` },
    onSuccess: (savedHome) => {
      form.reset({ name: savedHome.name, timeZone: savedHome.timeZone });
      setSaved(true);
      startTransition(() => {
        router.refresh();
      });
    },
    onError: (error) => {
      // Signed out, or no longer a member: the refreshed page sends the person where they belong.
      if (error.failure === "signedOut" || error.failure === "notFound") router.refresh();
    },
  });
  const errors = form.formState.errors;
  const { dirtyFields } = form.formState;

  const onSubmit = form.handleSubmit((values) => {
    setSaved(false);
    // Only what was changed, so a page left open never undoes a change made elsewhere.
    const patch: HomeSettingsPatchInput = {};
    if (dirtyFields.name) patch.name = values.name;
    if (dirtyFields.timeZone) patch.timeZone = values.timeZone;
    if (patch.name === undefined && patch.timeZone === undefined) return;
    mutation.mutate(patch);
  });

  const register = (name: keyof FormInput) =>
    form.register(name, {
      onChange: () => {
        setSaved(false);
      },
    });

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex max-w-xl flex-col gap-5"
    >
      <HomeFields
        name={register("name")}
        timeZone={register("timeZone")}
        nameError={errors.name?.message as HomeFieldError | undefined}
        timeZoneError={errors.timeZone?.message as HomeFieldError | undefined}
        timeZoneChoices={timeZoneChoices}
      />
      <HomeSaveFailureAlert failure={mutation.error?.failure ?? null} />
      {saved && !mutation.isPending ? (
        <FormAlert tone="success" announce>
          {t("settingsSaved")}
        </FormAlert>
      ) : null}
      <div>
        <Button type="submit" disabled={!hydrated} loading={mutation.isPending || refreshing}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
