"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import { classifyAuthError } from "@/auth/auth-errors";
import type { AccountChangeAction } from "@/auth/google-reauth";
import { reauthenticate } from "@/auth/reauthenticate";
import { changePasswordSchema, type ChangePasswordValues } from "@/auth/schemas";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { useCaptcha } from "@/components/auth/captcha";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";

import { ConfirmWithGoogle, ReauthFields, reauthModeFor, useReauthMessages } from "./reauth-fields";

export interface PasswordSettingProps {
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  /** The change Google has just confirmed for this page, if any (accounts without a password). */
  readonly confirmed: AccountChangeAction | null;
}

/**
 * Settings › Security › Password (S37, spec "Confirmed routine adult password changes and session
 * revocation"): the current password (and authenticator code), then the new one. Supabase Auth
 * keeps this session and signs out every other session of the account, on every device and in
 * every Home; the confirmation says so before and after. An account without a password (Google
 * only) confirms with Google first and then sets one.
 */
export function PasswordSetting({
  email,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
}: PasswordSettingProps) {
  const t = useTranslations("Security");
  const tAuth = useTranslations("Auth");
  const authMessages = useAuthMessages();
  const reauthMessage = useReauthMessages();
  const captcha = useCaptcha("reauthenticate");
  const mode = reauthModeFor(hasPassword, confirmed, "password");
  const [open, setOpen] = useState(mode === "confirmed");
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const resolver = useMemo(
    () => zodResolver(changePasswordSchema(twoFactor, mode === "password")),
    [twoFactor, mode],
  );
  const form = useForm<ChangePasswordValues>({
    resolver,
    defaultValues: { password: "", code: "", newPassword: "", confirmPassword: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    if (mode === "google") return;
    setFailure(null);
    if (mode === "password") {
      if (!captcha.ready) return;
      const failed = await reauthenticate(
        {
          email,
          password: values.password,
          code: twoFactor ? values.code : null,
          captchaOptions: captcha.options,
        },
        (client, sessionId) =>
          client.rpc("authorize_account_change", {
            p_action: "password",
            p_session_id: sessionId,
          }),
      );
      captcha.reset();
      form.setValue("password", "");
      form.setValue("code", "");
      if (failed) {
        setFailure(reauthMessage(failed));
        return;
      }
    }
    const { error } = await getSupabaseBrowserClient().auth.updateUser({
      password: values.newPassword,
    });
    if (error) {
      const kind = classifyAuthError(error);
      setFailure(kind === "unknown" ? t("notAllowed") : authMessages.failure(kind));
      return;
    }
    form.reset({ password: "", code: "", newPassword: "", confirmPassword: "" });
    setOpen(false);
    setDone(true);
  });

  if (mode === "google" && !done) {
    return (
      <div className="flex flex-col gap-4" data-testid="password-setting">
        <p className="text-body text-fg-muted">{t("passwordGoogleOnly")}</p>
        <ConfirmWithGoogle
          action="password"
          email={email}
          userId={userId}
          twoFactor={twoFactor}
          label={t("setPassword")}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="password-setting">
      {done ? (
        <FormAlert tone="success" announce>
          {hasPassword ? t("passwordChanged") : t("passwordSet")}
        </FormAlert>
      ) : null}
      {!open ? (
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(true);
              setDone(false);
              setFailure(null);
            }}
          >
            {t("changePassword")}
          </Button>
        </div>
      ) : (
        <form
          method="post"
          noValidate
          aria-label={hasPassword ? t("changePassword") : t("setPassword")}
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          className="flex flex-col gap-4 rounded-control border border-line p-4"
        >
          <p className="text-body">{t("passwordExplanation")}</p>
          {failure ? (
            <FormAlert tone="error" announce>
              {failure}
            </FormAlert>
          ) : null}
          {mode === "password" ? (
            <ReauthFields
              password={form.register("password")}
              code={form.register("code")}
              passwordError={form.formState.errors.password?.message}
              codeError={form.formState.errors.code?.message}
              withCode={twoFactor}
            />
          ) : null}
          <TextField
            label={tAuth("newPasswordLabel")}
            description={tAuth("passwordHint")}
            type="password"
            autoComplete="new-password"
            required
            error={authMessages.field(errors.newPassword?.message)}
            {...form.register("newPassword")}
          />
          <TextField
            label={tAuth("confirmPasswordLabel")}
            type="password"
            autoComplete="new-password"
            required
            error={authMessages.field(errors.confirmPassword?.message)}
            {...form.register("confirmPassword")}
          />
          {mode === "password" ? captcha.check : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={isSubmitting || (mode === "password" && !captcha.ready)}>
              {hasPassword ? t("changePasswordSubmit") : t("setPassword")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setFailure(null);
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
