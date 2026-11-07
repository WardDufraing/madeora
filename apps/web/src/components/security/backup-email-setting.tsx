"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import type { AccountChangeAction } from "@/auth/google-reauth";
import { reauthenticate } from "@/auth/reauthenticate";
import { backupEmailSchema, type BackupEmailValues } from "@/auth/schemas";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { useCaptcha } from "@/components/auth/captcha";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";

import { ConfirmWithGoogle, ReauthFields, reauthModeFor, useReauthMessages } from "./reauth-fields";

export interface BackupEmailSettingProps {
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  readonly confirmed: AccountChangeAction | null;
  /** The verified backup address and one waiting for its link, both masked by the database. */
  readonly backupEmail: string | null;
  readonly pendingBackupEmail: string | null;
}

type Intent = "set" | "remove";

/**
 * Settings › Security › Backup email (S37, spec "verified backup email"): a second address, only
 * for getting back in when the sign-in address is lost. Adding, changing and removing it need a
 * fresh reauthentication; the new address gets a single-use link and counts only once it is
 * opened by this account. Cancelling a pending address only takes something away, so it needs
 * nothing. The database never shows an address in full here.
 */
export function BackupEmailSetting({
  email,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
  backupEmail,
  pendingBackupEmail,
}: BackupEmailSettingProps) {
  const t = useTranslations("Security");
  const authMessages = useAuthMessages();
  const reauthMessage = useReauthMessages();
  const captcha = useCaptcha("reauthenticate");
  const mode = reauthModeFor(hasPassword, confirmed, "backup_email");
  const [intent, setIntent] = useState<Intent | null>(mode === "confirmed" ? "set" : null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<"sent" | null>(null);
  const resolver = useMemo(
    () => zodResolver(backupEmailSchema(twoFactor, mode === "password", intent === "remove")),
    [twoFactor, mode, intent],
  );
  const form = useForm<BackupEmailValues>({
    resolver,
    defaultValues: { password: "", code: "", email: "" },
  });
  const { errors, isSubmitting } = form.formState;

  function reload(query: string) {
    window.location.assign(new URL(`/settings/security?${query}#recovery`, window.location.origin));
  }

  const onSubmit = form.handleSubmit(async (values) => {
    if (mode === "google" || intent === null) return;
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
            p_action: "backup_email",
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
    const supabase = getSupabaseBrowserClient();
    if (intent === "remove") {
      const { error } = await supabase.rpc("remove_backup_email");
      if (error) {
        setFailure(
          error.hint === "reauthentication_required" ? t("reauthRequired") : t("notAllowed"),
        );
        return;
      }
      reload("backup=removed");
      return;
    }
    const { data, error } = await supabase.rpc("request_backup_email", { p_email: values.email });
    if (error) {
      setFailure(
        error.hint === "reauthentication_required" ? t("reauthRequired") : t("notAllowed"),
      );
      return;
    }
    switch (data) {
      case "sent":
        form.reset({ password: "", code: "", email: "" });
        setIntent(null);
        setNotice("sent");
        return;
      case "same_as_primary":
        form.setError("email", { message: "backupSameAsPrimary" });
        return;
      case "rate_limited":
        setFailure(authMessages.failure("rateLimited"));
        return;
      default:
        form.setError("email", { message: "emailInvalid" });
    }
  });

  async function cancelPending() {
    setFailure(null);
    const { error } = await getSupabaseBrowserClient().rpc("cancel_backup_email_change");
    if (error) {
      setFailure(authMessages.failure("unknown"));
      return;
    }
    reload("backup=cancelled");
  }

  const fieldError =
    errors.email?.message === "backupSameAsPrimary"
      ? t("backupSameAsPrimary")
      : authMessages.field(errors.email?.message);

  return (
    <div className="flex flex-col gap-4" data-testid="backup-email-setting">
      <p className="text-body">
        {backupEmail ? t("backupEmailCurrent", { email: backupEmail }) : t("backupEmailNone")}
      </p>
      {failure ? (
        <FormAlert tone="error" announce>
          {failure}
        </FormAlert>
      ) : null}
      {notice === "sent" ? (
        <FormAlert tone="success" announce>
          {t("backupEmailSent")}
        </FormAlert>
      ) : null}
      {pendingBackupEmail && notice === null ? (
        <div className="flex flex-col gap-3 rounded-control border border-line p-4">
          <p className="text-body">{t("backupEmailPending", { email: pendingBackupEmail })}</p>
          <div>
            <Button variant="ghost" onClick={() => void cancelPending()}>
              {t("cancelBackupEmail")}
            </Button>
          </div>
        </div>
      ) : null}

      {intent === null ? (
        mode === "google" ? (
          <ConfirmWithGoogle
            action="backup_email"
            email={email}
            userId={userId}
            twoFactor={twoFactor}
            label={backupEmail ? t("changeBackupEmail") : t("addBackupEmail")}
          />
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              onClick={() => {
                setIntent("set");
                setNotice(null);
                setFailure(null);
              }}
            >
              {backupEmail ? t("changeBackupEmail") : t("addBackupEmail")}
            </Button>
            {backupEmail ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setIntent("remove");
                  setNotice(null);
                  setFailure(null);
                }}
              >
                {t("removeBackupEmail")}
              </Button>
            ) : null}
          </div>
        )
      ) : (
        <form
          method="post"
          noValidate
          aria-label={intent === "remove" ? t("removeBackupEmail") : t("addBackupEmail")}
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          className="flex flex-col gap-4 rounded-control border border-line p-4"
        >
          <p className="text-body">
            {intent === "remove" ? t("removeBackupEmailExplanation") : t("backupEmailExplanation")}
          </p>
          {intent === "set" ? (
            <TextField
              label={t("backupEmailLabel")}
              type="email"
              autoComplete="email"
              required
              error={fieldError}
              {...form.register("email")}
            />
          ) : null}
          {mode === "password" ? (
            <>
              <ReauthFields
                password={form.register("password")}
                code={form.register("code")}
                passwordError={errors.password?.message}
                codeError={errors.code?.message}
                withCode={twoFactor}
              />
              {captcha.check}
            </>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              variant={intent === "remove" ? "destructive" : "primary"}
              loading={isSubmitting || (mode === "password" && !captcha.ready)}
            >
              {intent === "remove" ? t("removeBackupEmail") : t("sendBackupLink")}
            </Button>
            {mode === "confirmed" && intent === "set" && backupEmail ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setIntent("remove");
                }}
              >
                {t("removeBackupEmail")}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              onClick={() => {
                setIntent(null);
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
