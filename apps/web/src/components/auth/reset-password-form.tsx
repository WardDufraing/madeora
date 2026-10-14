"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { classifyAuthError, type AuthFailure } from "@/auth/auth-errors";
import { announceSignedOut } from "@/auth/broadcast";
import { newPasswordSchema, type NewPasswordValues } from "@/auth/schemas";
import { getMemoryOnlySupabaseClient } from "@/auth/supabase-browser";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";

import { FormAlert } from "./form-alert";
import { useAuthMessages } from "./use-auth-messages";

export interface ResetPasswordFormProps {
  /** The one-time token from the reset email, already checked for shape; null when absent. */
  readonly tokenHash: string | null;
}

type Stage = "form" | "signOutFailed" | "done";

/**
 * Chooses a new password from a reset link (spec: stricter recovery path).
 *
 * 1. The link's one-time token is used only when the form is submitted, so mail scanners that
 *    open links cannot use it up. Using it opens a session that lives only in this page's memory
 *    (never in cookies), so an unfinished reset never signs the browser in.
 * 2. The new password is saved. Supabase Auth signs out every other session of the account in the
 *    same step (it does so for any password change made from a session; re-check on Supabase
 *    upgrades, which the E2E suite does).
 * 3. The reset session itself is then ended too (`scope: global`, which also catches any session
 *    created in between), and the person signs in again. If that fails, the page says so and
 *    offers a retry; it never reports success.
 */
export function ResetPasswordForm({ tokenHash }: ResetPasswordFormProps) {
  const t = useTranslations("Auth");
  const hydrated = useHydrated();
  const messages = useAuthMessages();
  const [stage, setStage] = useState<Stage>("form");
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [verified, setVerified] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<NewPasswordValues>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });
  const { errors, isSubmitting } = form.formState;

  async function signOutEverywhere(): Promise<void> {
    const { error } = await getMemoryOnlySupabaseClient("password-reset").auth.signOut({
      scope: "global",
    });
    if (error) {
      setStage("signOutFailed");
      return;
    }
    setStage("done");
    announceSignedOut();
    window.location.assign(new URL("/sign-in?status=password-changed", window.location.origin));
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);
    const auth = getMemoryOnlySupabaseClient("password-reset").auth;
    if (!verified) {
      if (tokenHash === null) return;
      const { error } = await auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
      if (error) {
        const kind = classifyAuthError(error);
        setFailure(kind === "invalidCredentials" ? "linkInvalid" : kind);
        return;
      }
      setVerified(true);
    }
    const { error } = await auth.updateUser({ password: values.password });
    if (error) {
      setFailure(classifyAuthError(error));
      return;
    }
    await signOutEverywhere();
  });

  if (!verified && tokenHash === null) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="error">{t("resetMissingToken")}</FormAlert>
        <Link href="/forgot-password" className="text-body font-medium text-accent-fg underline">
          {t("requestNewLink")}
        </Link>
      </div>
    );
  }

  if (stage === "signOutFailed") {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="error" announce>
          {t("signOutEverywhereFailed")}
        </FormAlert>
        <Button
          loading={retrying}
          onClick={() => {
            setRetrying(true);
            void signOutEverywhere().finally(() => {
              setRetrying(false);
            });
          }}
        >
          {t("retrySignOut")}
        </Button>
      </div>
    );
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-4"
    >
      <p className="text-body text-fg">{t("resetDescription")}</p>
      {failure ? (
        <FormAlert tone="error" announce>
          {messages.failure(failure)}
          {failure === "linkInvalid" ? (
            <>
              {" "}
              <Link href="/forgot-password" className="font-medium text-accent-fg underline">
                {t("requestNewLink")}
              </Link>
            </>
          ) : null}
        </FormAlert>
      ) : null}
      <TextField
        label={t("newPasswordLabel")}
        description={t("passwordHint")}
        type={showPassword ? "text" : "password"}
        autoComplete="new-password"
        required
        error={messages.field(errors.password?.message)}
        {...form.register("password")}
      />
      <TextField
        label={t("confirmPasswordLabel")}
        type={showPassword ? "text" : "password"}
        autoComplete="new-password"
        required
        error={messages.field(errors.confirmPassword?.message)}
        {...form.register("confirmPassword")}
      />
      <Checkbox
        label={t("showPassword")}
        checked={showPassword}
        onChange={(event) => {
          setShowPassword(event.target.checked);
        }}
      />
      <Button type="submit" disabled={!hydrated} loading={isSubmitting || stage === "done"}>
        {t("resetSubmit")}
      </Button>
    </form>
  );
}
