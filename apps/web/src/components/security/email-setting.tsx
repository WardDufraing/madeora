"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { isAuthError } from "@supabase/supabase-js";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import { classifyAuthError } from "@/auth/auth-errors";
import type { AccountChangeAction } from "@/auth/google-reauth";
import { reauthenticate } from "@/auth/reauthenticate";
import { changeEmailSchema, type ChangeEmailValues } from "@/auth/schemas";
import { maskEmail } from "@/auth/sessions";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { useCaptcha } from "@/components/auth/captcha";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";

import { ConfirmWithGoogle, ReauthFields, reauthModeFor, useReauthMessages } from "./reauth-fields";

export interface EmailSettingProps {
  readonly email: string;
  /** The address waiting for confirmation, if a change was started. */
  readonly pendingEmail: string | null;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  /** The change Google has just confirmed for this page, if any (accounts without a password). */
  readonly confirmed: AccountChangeAction | null;
}

/**
 * Settings › Security › Email address (S37, spec "Confirmed secure self-service primary account
 * email changes"). After reauthentication, Supabase Auth sends a single-use link to the new
 * address; until it is opened the current address stays the account email for sign-in and
 * security notices. The old address gets Supabase Auth's "email changed" notice afterwards. An
 * address that is already in use gets the same answer as any other (no account enumeration).
 */
export function EmailSetting({
  email,
  pendingEmail,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
}: EmailSettingProps) {
  const t = useTranslations("Security");
  const authMessages = useAuthMessages();
  const reauthMessage = useReauthMessages();
  const captcha = useCaptcha("reauthenticate");
  const mode = reauthModeFor(hasPassword, confirmed, "email");
  const [open, setOpen] = useState(mode === "confirmed");
  const [failure, setFailure] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [notice, setNotice] = useState<"resent" | null>(null);
  const resolver = useMemo(
    () => zodResolver(changeEmailSchema(twoFactor, email, mode === "password")),
    [twoFactor, email, mode],
  );
  const form = useForm<ChangeEmailValues>({
    resolver,
    defaultValues: { password: "", code: "", email: "" },
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
          client.rpc("authorize_account_change", { p_action: "email", p_session_id: sessionId }),
      );
      captcha.reset();
      form.setValue("password", "");
      form.setValue("code", "");
      if (failed) {
        setFailure(reauthMessage(failed));
        return;
      }
    }
    const redirect = new URL("/auth/confirm-email-change", window.location.origin);
    const { error } = await getSupabaseBrowserClient().auth.updateUser(
      { email: values.email },
      { emailRedirectTo: redirect.toString() },
    );
    // "Already in use" reads like success: the page never says whether an address has an account.
    if (error && !(isAuthError(error) && error.code === "email_exists")) {
      const kind = classifyAuthError(error);
      setFailure(kind === "unknown" ? t("notAllowed") : authMessages.failure(kind));
      return;
    }
    form.reset({ password: "", code: "", email: "" });
    setOpen(false);
    setSentTo(values.email);
  });

  async function resend() {
    if (pendingEmail === null) return;
    setFailure(null);
    const { error } = await getSupabaseBrowserClient().auth.resend({
      type: "email_change",
      email: pendingEmail,
    });
    if (error) {
      setFailure(authMessages.failure(classifyAuthError(error)));
      return;
    }
    setNotice("resent");
  }

  async function cancelPending() {
    setFailure(null);
    const { error } = await getSupabaseBrowserClient().rpc("cancel_my_email_change");
    if (error) {
      setFailure(authMessages.failure("unknown"));
      return;
    }
    window.location.assign(
      new URL("/settings/security?email=cancelled#email", window.location.origin),
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="email-setting">
      <p className="text-body">{t("currentEmail", { email })}</p>
      {failure ? (
        <FormAlert tone="error" announce>
          {failure}
        </FormAlert>
      ) : null}
      {sentTo ? (
        <FormAlert tone="success" announce>
          {t("emailSent", { email: sentTo })}
        </FormAlert>
      ) : null}
      {pendingEmail && !sentTo ? (
        <div className="flex flex-col gap-3 rounded-control border border-line p-4">
          <p className="text-body">{t("emailPending", { email: maskEmail(pendingEmail) })}</p>
          {notice === "resent" ? (
            <p role="status" className="text-helper text-fg-muted">
              {t("emailResent")}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => void resend()}>
              {t("resendEmail")}
            </Button>
            <Button variant="ghost" onClick={() => void cancelPending()}>
              {t("cancelEmailChange")}
            </Button>
          </div>
        </div>
      ) : null}
      {mode === "google" ? (
        <ConfirmWithGoogle
          action="email"
          email={email}
          userId={userId}
          twoFactor={twoFactor}
          label={t("changeEmail")}
        />
      ) : !open ? (
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(true);
              setSentTo(null);
              setFailure(null);
            }}
          >
            {t("changeEmail")}
          </Button>
        </div>
      ) : (
        <form
          method="post"
          noValidate
          aria-label={t("changeEmail")}
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          className="flex flex-col gap-4 rounded-control border border-line p-4"
        >
          <p className="text-body">{t("emailExplanation")}</p>
          <TextField
            label={t("newEmail")}
            type="email"
            autoComplete="email"
            required
            error={authMessages.field(errors.email?.message)}
            {...form.register("email")}
          />
          {mode === "password" ? (
            <>
              <ReauthFields
                password={form.register("password")}
                code={form.register("code")}
                passwordError={form.formState.errors.password?.message}
                codeError={form.formState.errors.code?.message}
                withCode={twoFactor}
              />
              {captcha.check}
            </>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={isSubmitting || (mode === "password" && !captcha.ready)}>
              {t("changeEmailSubmit")}
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
