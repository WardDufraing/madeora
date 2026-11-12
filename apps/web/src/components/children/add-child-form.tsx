"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { childAgeBands, suggestedPreset } from "@madeora/domain/permissions";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { accentColorSchema, type AccentColor } from "@/accent/accent";
import { AccentPicker } from "@/components/accent/accent-picker";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { createChild } from "@/children/api";
import type { MemberActionError } from "@/members/manage-api";
import { DISPLAY_NAME_MAX_LENGTH, optionalNameSchema } from "@/preferences/schema";

export interface GuardianOption {
  readonly membershipId: string;
  readonly name: string;
}

const formSchema = z.object({
  name: optionalNameSchema.refine((name) => name !== null, { message: "childNameRequired" }),
  primaryGuardianMembershipId: z.uuid(),
  ageBand: z.union([z.literal(""), z.enum(childAgeBands)]),
  accentColor: accentColorSchema,
});
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

const ageBandKey = {
  under_8: "ageBandUnder8",
  "8_12": "ageBand8to12",
  "13_17": "ageBand13to17",
} as const;

const presetKey = {
  young_child: "presetYoungChild",
  child: "presetChild",
  teen: "presetTeen",
} as const;

/**
 * Home → Members → Add child (S41; spec "Confirmed quick child creation"): only a name, a primary
 * guardian and a colour are needed; the age band is optional and only suggests a preset for later.
 * No email, username, PIN or password. Every new child starts on the Young Child preset. People
 * who may not name someone else as guardian (anyone but the Owner and Administrators allowed to
 * add members) see only themselves. The server and the database check everything again.
 */
export function AddChildForm({
  homeId,
  guardianOptions,
  defaultGuardianMembershipId,
  suggestedColor,
}: {
  readonly homeId: string;
  readonly guardianOptions: readonly GuardianOption[];
  readonly defaultGuardianMembershipId: string;
  readonly suggestedColor: AccentColor;
}) {
  const t = useTranslations("Children");
  const tSettings = useTranslations("Settings");
  const router = useRouter();
  const hydrated = useHydrated();
  // One id per form, so a retried submit returns the same child.
  const [requestId] = useState(() => crypto.randomUUID());
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      primaryGuardianMembershipId: defaultGuardianMembershipId,
      ageBand: "",
      accentColor: suggestedColor,
    },
  });
  const mutation = useMutation<{ readonly membershipId: string }, MemberActionError, FormOutput>({
    mutationFn: (values) =>
      createChild(homeId, {
        name: values.name,
        primaryGuardianMembershipId: values.primaryGuardianMembershipId,
        ageBand: values.ageBand === "" ? null : values.ageBand,
        accentColor: values.accentColor,
        requestId,
      }),
    onSuccess: ({ membershipId }) => {
      router.push(`/homes/${homeId}/children/${membershipId}?created=1`);
      router.refresh();
    },
  });
  const nameError = form.formState.errors.name?.message;
  const ageBand = useWatch({ control: form.control, name: "ageBand" });

  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-5"
      data-testid="add-child-form"
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          if (!mutation.isPending) mutation.mutate(values);
        })(event);
      }}
    >
      <TextField
        label={t("nameLabel")}
        description={t("nameHint", { max: DISPLAY_NAME_MAX_LENGTH })}
        dir="auto"
        autoComplete="off"
        maxLength={DISPLAY_NAME_MAX_LENGTH * 2}
        error={
          nameError === "childNameRequired"
            ? t("nameRequired")
            : nameError === "displayNameTooLong"
              ? tSettings("displayNameTooLong", { max: DISPLAY_NAME_MAX_LENGTH })
              : nameError
                ? tSettings("displayNameInvalid")
                : undefined
        }
        {...form.register("name")}
      />
      {guardianOptions.length > 1 ? (
        <SelectField
          label={t("primaryGuardianLabel")}
          description={t("primaryGuardianHint")}
          options={guardianOptions.map((option) => ({
            value: option.membershipId,
            label: option.name,
          }))}
          {...form.register("primaryGuardianMembershipId")}
        />
      ) : (
        <p className="text-body text-fg" data-testid="primary-guardian-self">
          {t("primaryGuardianSelf")}
        </p>
      )}
      <SelectField
        label={t("ageBandLabel")}
        description={t("ageBandHint")}
        options={[
          { value: "", label: t("ageBandNone") },
          ...childAgeBands.map((band) => ({ value: band, label: t(ageBandKey[band]) })),
        ]}
        {...form.register("ageBand")}
      />
      <p className="text-helper text-fg-muted" data-testid="preset-suggestion">
        {t("startsRestricted", {
          suggested: t(presetKey[suggestedPreset(ageBand === "" ? null : ageBand)]),
        })}
      </p>
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
      <p className="text-helper text-fg-muted">{t("noEmailNeeded")}</p>
      <MemberFailureAlert failure={mutation.error?.failure ?? null} />
      <div>
        <Button type="submit" disabled={!hydrated} loading={mutation.isPending}>
          {t("addButton")}
        </Button>
      </div>
    </form>
  );
}
