"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import type { AccountChangeAction } from "@/auth/google-reauth";
import { reauthenticate } from "@/auth/reauthenticate";
import { reauthenticationSchema, type ReauthenticationValues } from "@/auth/schemas";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { useCaptcha } from "@/components/auth/captcha";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";

import { ConfirmWithGoogle, ReauthFields, reauthModeFor, useReauthMessages } from "./reauth-fields";
import { RecoveryCodes } from "./recovery-codes";

export interface AccountRecoveryCodesSettingProps {
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  readonly confirmed: AccountChangeAction | null;
  readonly codesLeft: number;
  /** Recovery needs both the backup address and one of these codes. */
  readonly hasBackupEmail: boolean;
}

/**
 * Settings › Security › Account recovery codes (S37): with the backup address, one of these lets
 * the account holder back in after losing both the password and the sign-in mailbox, after a
 * waiting period. Separate from the two-factor recovery codes. Creating a set needs a fresh
 * reauthentication, replaces the old set and shows the new one once.
 */
export function AccountRecoveryCodesSetting({
  email,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
  codesLeft,
  hasBackupEmail,
}: AccountRecoveryCodesSettingProps) {
  const t = useTranslations("Security");
  const reauthMessage = useReauthMessages();
  const captcha = useCaptcha("reauthenticate");
  const mode = reauthModeFor(hasPassword, confirmed, "account_recovery_codes");
  const [open, setOpen] = useState(mode === "confirmed");
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const resolver = useMemo(
    () => zodResolver(reauthenticationSchema(twoFactor, mode === "password")),
    [twoFactor, mode],
  );
  const form = useForm<ReauthenticationValues>({
    resolver,
    defaultValues: { password: "", code: "" },
  });

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
            p_action: "account_recovery_codes",
            p_session_id: sessionId,
          }),
      );
      captcha.reset();
      form.reset({ password: "", code: "" });
      if (failed) {
        setFailure(reauthMessage(failed));
        return;
      }
    }
    const { data, error } = await getSupabaseBrowserClient().rpc("create_account_recovery_codes");
    if (error) {
      setFailure(
        error.hint === "reauthentication_required" ? t("reauthRequired") : t("notAllowed"),
      );
      return;
    }
    setCodes(data);
  });

  if (codes) {
    return (
      <RecoveryCodes
        kind="account"
        codes={codes}
        onDone={() => {
          window.location.assign(
            new URL("/settings/security?accountCodes=new#recovery", window.location.origin),
          );
        }}
      />
    );
  }

  const label = codesLeft > 0 ? t("replaceAccountCodes") : t("createAccountCodes");
  return (
    <div className="flex flex-col gap-4" data-testid="account-recovery-codes-setting">
      <p className="text-body">
        {codesLeft > 0 ? t("accountCodesLeft", { count: codesLeft }) : t("accountCodesNone")}
      </p>
      {!hasBackupEmail ? (
        <p className="text-helper text-fg-muted">{t("accountCodesNeedBackup")}</p>
      ) : null}
      {failure ? (
        <FormAlert tone="error" announce>
          {failure}
        </FormAlert>
      ) : null}
      {!open ? (
        mode === "google" ? (
          <ConfirmWithGoogle
            action="account_recovery_codes"
            email={email}
            userId={userId}
            twoFactor={twoFactor}
            label={label}
          />
        ) : (
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(true);
                setFailure(null);
              }}
            >
              {label}
            </Button>
          </div>
        )
      ) : (
        <form
          method="post"
          noValidate
          aria-label={label}
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          className="flex flex-col gap-4 rounded-control border border-line p-4"
        >
          <p className="text-body">{t("accountCodesExplanation")}</p>
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
            <Button
              type="submit"
              loading={form.formState.isSubmitting || (mode === "password" && !captcha.ready)}
            >
              {label}
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
