"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";

import {
  recoveryCodeSchema,
  totpCodeSchema,
  type RecoveryCodeValues,
  type TotpCodeValues,
} from "@/auth/schemas";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { classifyTwoFactorError } from "@/auth/two-factor";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";

import { useTwoFactorMessages } from "./reauth-fields";

export interface TwoFactorChallengeProps {
  readonly factorId: string;
  /** Same-site path to open afterwards, already checked by `safeNextPath` on the server. */
  readonly next: string;
}

/**
 * The second step of signing in for an account with two-factor sign-in (S37), whatever the first
 * step was (password or Google): a code from the authenticator, or one recovery code if the
 * authenticator is lost. Until then the session can do nothing else (the server and the database
 * both refuse it).
 */
export function TwoFactorChallenge({ factorId, next }: TwoFactorChallengeProps) {
  const t = useTranslations("Security");
  const authMessages = useAuthMessages();
  const codeMessage = useTwoFactorMessages();
  const [mode, setMode] = useState<"code" | "recovery">("code");
  const [failure, setFailure] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [trust, setTrust] = useState(false);
  const codeForm = useForm<TotpCodeValues>({
    resolver: zodResolver(totpCodeSchema),
    defaultValues: { code: "" },
  });
  const recoveryForm = useForm<RecoveryCodeValues>({
    resolver: zodResolver(recoveryCodeSchema),
    defaultValues: { recoveryCode: "" },
  });

  function go(path: string) {
    // A full page load, so the server checks the upgraded session and every cache starts empty.
    setLeaving(true);
    window.location.assign(new URL(path, window.location.origin));
  }

  const onCode = codeForm.handleSubmit(async (values) => {
    setFailure(null);
    const { error } = await getSupabaseBrowserClient().auth.mfa.challengeAndVerify({
      factorId,
      code: totpCodeSchema.parse(values).code,
    });
    if (error) {
      setFailure(codeMessage(classifyTwoFactorError(error)));
      codeForm.setValue("code", "");
      codeForm.setFocus("code");
      return;
    }
    if (trust) {
      // Best effort: if trusting fails, the sign-in still stands and the code is asked next time.
      await fetch("/api/v1/me/trusted-device", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => undefined);
    }
    go(next);
  });

  const onRecovery = recoveryForm.handleSubmit(async (values) => {
    setFailure(null);
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase.rpc("redeem_two_factor_recovery_code", {
      p_code: recoveryCodeSchema.parse(values).recoveryCode,
    });
    recoveryForm.setValue("recoveryCode", "");
    if (error) {
      setFailure(authMessages.failure("unknown"));
      return;
    }
    if (data === "rate_limited") {
      setFailure(authMessages.failure("rateLimited"));
      return;
    }
    if (data === "invalid") {
      setFailure(t("wrongRecoveryCode"));
      return;
    }
    // The authenticator was removed: the session needs no second step any more.
    await supabase.auth.refreshSession();
    go("/settings/security?recovered=1");
  });

  async function signOut() {
    await getSupabaseBrowserClient().auth.signOut({ scope: "local" });
    go("/sign-in?status=signed-out");
  }

  return (
    <div className="flex flex-col gap-4">
      {failure ? (
        <FormAlert tone="error" announce>
          {failure}
        </FormAlert>
      ) : null}
      {mode === "code" ? (
        <form
          method="post"
          noValidate
          onSubmit={(event) => {
            void onCode(event);
          }}
          className="flex flex-col gap-4"
        >
          <p className="text-body">{t("challengeDescription")}</p>
          <TextField
            label={t("authenticatorCode")}
            description={t("authenticatorCodeHint")}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={9}
            required
            error={authMessages.field(codeForm.formState.errors.code?.message)}
            {...codeForm.register("code")}
          />
          <Checkbox
            label={t("trustDevice")}
            description={t("trustDeviceHint")}
            checked={trust}
            onChange={(event) => {
              setTrust(event.currentTarget.checked);
            }}
          />
          <Button type="submit" loading={codeForm.formState.isSubmitting || leaving}>
            {t("challengeSubmit")}
          </Button>
        </form>
      ) : (
        <form
          method="post"
          noValidate
          onSubmit={(event) => {
            void onRecovery(event);
          }}
          className="flex flex-col gap-4"
        >
          <p className="text-body">{t("recoveryDescription")}</p>
          <TextField
            label={t("recoveryCode")}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            error={authMessages.field(recoveryForm.formState.errors.recoveryCode?.message)}
            {...recoveryForm.register("recoveryCode")}
          />
          <Button type="submit" loading={recoveryForm.formState.isSubmitting || leaving}>
            {t("recoverySubmit")}
          </Button>
        </form>
      )}
      <div className="flex flex-col items-start gap-2 text-body">
        <Button
          variant="ghost"
          onClick={() => {
            setFailure(null);
            setMode(mode === "code" ? "recovery" : "code");
          }}
        >
          {mode === "code" ? t("useRecoveryCode") : t("useAuthenticator")}
        </Button>
        <Button variant="ghost" onClick={() => void signOut()}>
          {t("challengeSignOut")}
        </Button>
      </div>
    </div>
  );
}
