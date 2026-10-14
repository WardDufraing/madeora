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
import { isolate } from "@/invitations/format";
import type { HomeProfileSaveFailure } from "@/members/profile-api";
import {
  DISPLAY_NAME_MAX_LENGTH,
  optionalNameSchema,
  type DisplayNameError,
} from "@/preferences/schema";
import { useSaveHomeProfile } from "@/members/use-save-home-profile";

const formSchema = z.object({ name: optionalNameSchema });
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

export interface NameOverrideFieldProps {
  readonly homeId: string;
  readonly field: "nickname" | "displayName";
  /** The saved override, or `null` when this field inherits. */
  readonly saved: string | null;
  /** For the Home display name: the global display name it falls back to. */
  readonly inherited?: string | null;
  /** The unsaved, normalized value for the preview: `null` for empty, `undefined` for invalid. */
  readonly onDraftChange: (draft: string | null | undefined) => void;
}

const failureKey = {
  signedOut: "saveSignedOut",
  invalid: "saveInvalid",
  notFound: "saveNotFound",
  network: "saveNetwork",
  failed: "saveFailed",
} as const satisfies Record<HomeProfileSaveFailure, string>;

/**
 * One Home-specific name (nickname or Home display name), saved on its own with a button to stop
 * overriding. The same visible-name rule as every name other people see; the server checks again.
 */
export function NameOverrideField({
  homeId,
  field,
  saved,
  inherited,
  onDraftChange,
}: NameOverrideFieldProps) {
  const t = useTranslations("Members");
  const tSettings = useTranslations("Settings");
  const hydrated = useHydrated();
  const [notice, setNotice] = useState<"saved" | "removed" | null>(null);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: saved ?? "" },
  });
  const { mutation, saving, failure } = useSaveHomeProfile(homeId, (profile) => {
    const value = profile[field];
    form.reset({ name: value ?? "" });
    onDraftChange(undefined);
    setNotice(value === null ? "removed" : "saved");
  });
  const error = form.formState.errors.name?.message as DisplayNameError | undefined;
  const { isDirty } = form.formState;

  const nickname = field === "nickname";
  const onSubmit = form.handleSubmit((values) => {
    setNotice(null);
    if (!isDirty) return;
    mutation.mutate(nickname ? { nickname: values.name } : { displayName: values.name });
  });

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-3"
      data-testid={`${field}-form`}
    >
      <TextField
        label={nickname ? t("nickname") : t("homeName")}
        description={
          nickname
            ? t("nicknameHint", { max: DISPLAY_NAME_MAX_LENGTH })
            : t("homeNameHint", { max: DISPLAY_NAME_MAX_LENGTH })
        }
        dir="auto"
        autoComplete="off"
        maxLength={DISPLAY_NAME_MAX_LENGTH * 2}
        error={
          error === "displayNameTooLong"
            ? tSettings("displayNameTooLong", { max: DISPLAY_NAME_MAX_LENGTH })
            : error === "displayNameInvalid"
              ? tSettings("displayNameInvalid")
              : undefined
        }
        {...form.register("name", {
          onChange: (event: { target: { value: string } }) => {
            setNotice(null);
            const parsed = optionalNameSchema.safeParse(event.target.value);
            onDraftChange(parsed.success ? parsed.data : undefined);
          },
        })}
      />
      {!nickname && saved === null ? (
        <p className="text-helper text-fg-muted">
          {inherited ? t("inheritingName", { name: isolate(inherited) }) : t("inheritingNoName")}
        </p>
      ) : null}
      {failure ? (
        <FormAlert tone="error" announce>
          {t(failureKey[failure])}
        </FormAlert>
      ) : null}
      {notice && !mutation.isPending ? (
        <FormAlert tone="success" announce>
          {notice === "removed"
            ? nickname
              ? t("nicknameRemoved")
              : t("homeNameRemoved")
            : nickname
              ? t("nicknameSaved")
              : t("homeNameSaved")}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!hydrated} loading={saving}>
          {t("save")}
        </Button>
        {saved !== null ? (
          <Button
            variant="secondary"
            disabled={!hydrated || saving}
            onClick={() => {
              setNotice(null);
              mutation.mutate(nickname ? { nickname: null } : { displayName: null });
            }}
          >
            {nickname ? t("removeNickname") : t("useGlobalName")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
