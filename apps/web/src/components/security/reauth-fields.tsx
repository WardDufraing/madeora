"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";

import {
  browserSessionIsAal2,
  startGoogleReauth,
  verifyReauthCode,
  type AccountChangeAction,
} from "@/auth/google-reauth";
import type { ReauthenticationError } from "@/auth/reauthenticate";
import { totpCodeSchema, type TotpCodeValues } from "@/auth/schemas";
import { classifyMethodChangeError } from "@/auth/sign-in-methods";
import { classifyTwoFactorError, type TwoFactorFailure } from "@/auth/two-factor";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";

export interface ReauthFieldsProps {
  /** The form's registrations of its `password` and `code` fields, and their error keys. */
  readonly password: UseFormRegisterReturn<"password">;
  readonly code: UseFormRegisterReturn<"code">;
  readonly passwordError: string | undefined;
  readonly codeError: string | undefined;
  /** Ask for an authenticator code too (the account has two-factor sign-in). */
  readonly withCode: boolean;
}

/** "Confirm it's you": the current password and, with two-factor sign-in, a code (S37). */
export function ReauthFields({
  password,
  code,
  passwordError,
  codeError,
  withCode,
}: ReauthFieldsProps) {
  const t = useTranslations("Security");
  const messages = useAuthMessages();
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-2 text-body font-medium">{t("confirmItsYou")}</legend>
      <TextField
        label={t("currentPassword")}
        type="password"
        autoComplete="current-password"
        required
        error={messages.field(passwordError)}
        {...password}
      />
      {withCode ? (
        <TextField
          label={t("authenticatorCode")}
          description={t("authenticatorCodeHint")}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={9}
          required
          error={messages.field(codeError)}
          {...code}
        />
      ) : null}
    </fieldset>
  );
}

/** One translated message for a failed authenticator code. */
export function useTwoFactorMessages(): (failure: TwoFactorFailure) => string {
  const t = useTranslations("Security");
  const messages = useAuthMessages();
  return (failure) => {
    switch (failure) {
      case "wrongCode":
        return t("wrongCode");
      case "expired":
        return t("codeExpired");
      case "tryLater":
        return t("codeTryLater");
      case "rateLimited":
        return messages.failure("rateLimited");
      case "network":
        return messages.failure("network");
      case "unknown":
        return messages.failure("unknown");
    }
  };
}

/** One translated message for a failed reauthentication, naming the step that failed. */
export function useReauthMessages(): (failure: ReauthenticationError) => string {
  const t = useTranslations("Security");
  const tMethods = useTranslations("SignInMethods");
  const messages = useAuthMessages();
  const twoFactor = useTwoFactorMessages();
  return (failure) => {
    if (failure.step === "code") return twoFactor(classifyTwoFactorError(failure.error));
    const kind = classifyMethodChangeError(failure.error);
    switch (kind) {
      case "wrongPassword":
        return tMethods("wrongPassword");
      case "reauthRequired":
        return t("reauthRequired");
      case "notAllowed":
        return t("notAllowed");
      case "rateLimited":
      case "captchaFailed":
      case "network":
      case "unknown":
        return messages.failure(kind);
      default:
        return messages.failure("unknown");
    }
  };
}

export interface ConfirmWithGoogleProps {
  readonly action: AccountChangeAction;
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  /** The button's label; "Confirm with Google" by default. */
  readonly label?: string;
  readonly variant?: "primary" | "secondary" | "destructive";
}

/**
 * For accounts without a password (Google only): confirms it's you with Google before `action`,
 * and comes back to the change, which then asks for nothing more (S37). On a trusted browser
 * (whose session skipped the code) the authenticator code comes first, here; otherwise after
 * Google (see `@/auth/google-reauth`).
 */
export function ConfirmWithGoogle({
  action,
  email,
  userId,
  twoFactor,
  label,
  variant = "secondary",
}: ConfirmWithGoogleProps) {
  const t = useTranslations("Security");
  const messages = useAuthMessages();
  const codeMessage = useTwoFactorMessages();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [askCode, setAskCode] = useState(false);
  const form = useForm<TotpCodeValues>({
    resolver: zodResolver(totpCodeSchema),
    defaultValues: { code: "" },
  });

  async function leave(codeStillNeeded: boolean) {
    const { error } = await startGoogleReauth(
      { action, userId, twoFactor: codeStillNeeded },
      email,
    );
    // On success the browser is already on its way to Google.
    if (error) {
      setFailure(messages.failure("unknown"));
      setPending(false);
    }
  }

  async function start() {
    setPending(true);
    setFailure(null);
    if (twoFactor && !(await browserSessionIsAal2())) {
      setAskCode(true);
      setPending(false);
      return;
    }
    await leave(twoFactor);
  }

  const submitCode = form.handleSubmit(async (values) => {
    setFailure(null);
    setPending(true);
    const { error, noFactor } = await verifyReauthCode(
      "browser",
      totpCodeSchema.parse(values).code,
    );
    if (noFactor || error) {
      setFailure(
        noFactor ? messages.failure("unknown") : codeMessage(classifyTwoFactorError(error)),
      );
      form.setValue("code", "");
      form.setFocus("code");
      setPending(false);
      return;
    }
    await leave(false);
  });

  return (
    <div className="flex flex-col gap-3">
      {failure ? (
        <FormAlert tone="error" announce>
          {failure}
        </FormAlert>
      ) : null}
      {askCode ? (
        <form
          method="post"
          noValidate
          aria-label={label ?? t("confirmWithGoogle")}
          onSubmit={(event) => {
            void submitCode(event);
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-body">{t("googleCodeFirst")}</p>
          <TextField
            label={t("authenticatorCode")}
            description={t("authenticatorCodeHint")}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={9}
            required
            error={messages.field(form.formState.errors.code?.message)}
            {...form.register("code")}
          />
          <div>
            <Button type="submit" variant={variant} loading={pending}>
              {label ?? t("confirmWithGoogle")}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            variant={variant}
            loading={pending}
            onClick={() => {
              void start();
            }}
          >
            {label ?? t("confirmWithGoogle")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * How a change confirms it's you: the password (and code) in the form, Google first (accounts
 * without a password), or nothing more because Google already confirmed this very change.
 */
export type ReauthMode = "password" | "google" | "confirmed";

export function reauthModeFor(
  hasPassword: boolean,
  confirmed: AccountChangeAction | null,
  action: AccountChangeAction,
): ReauthMode {
  if (hasPassword) return "password";
  return confirmed === action ? "confirmed" : "google";
}
