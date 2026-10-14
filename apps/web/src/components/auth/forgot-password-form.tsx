"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { classifyAuthError, type AuthFailure } from "@/auth/auth-errors";
import { emailOnlySchema, type EmailOnlyValues } from "@/auth/schemas";
import { emailLinkTarget } from "@/auth/email-links";
import { getMemoryOnlySupabaseClient } from "@/auth/supabase-browser";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";

import { useCaptcha } from "./captcha";
import { FormAlert } from "./form-alert";
import { useAuthMessages } from "./use-auth-messages";

/** Asks for a reset link. The answer never says whether the address has an account. */
export function ForgotPasswordForm() {
  const t = useTranslations("Auth");
  const hydrated = useHydrated();
  const messages = useAuthMessages();
  const captcha = useCaptcha("forgot-password");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const form = useForm<EmailOnlyValues>({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    // Turnstile has no token yet (the button shows busy); Supabase Auth would refuse the request.
    if (!captcha.ready) return;
    setFailure(null);
    setSentTo(null);
    const { error } = await getMemoryOnlySupabaseClient(
      "email-requests",
    ).auth.resetPasswordForEmail(values.email, {
      redirectTo: emailLinkTarget("/reset-password"),
      ...captcha.options,
    });
    captcha.reset();
    const kind = error ? classifyAuthError(error) : null;
    // Rate limits, connection problems and a failed security check say nothing about the account;
    // anything else reads as sent.
    if (kind === "rateLimited" || kind === "network" || kind === "captchaFailed") setFailure(kind);
    else setSentTo(values.email);
  });

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-4"
    >
      <p className="text-body text-fg">{t("forgotDescription")}</p>
      {sentTo !== null ? (
        <FormAlert tone="success" announce>
          {t("forgotSent", { email: sentTo })}
        </FormAlert>
      ) : null}
      {failure ? (
        <FormAlert tone="error" announce>
          {messages.failure(failure)}
        </FormAlert>
      ) : null}
      <TextField
        label={t("emailLabel")}
        type="email"
        autoComplete="email"
        required
        error={messages.field(errors.email?.message)}
        {...form.register("email")}
      />
      {captcha.check}
      <Button type="submit" disabled={!hydrated} loading={isSubmitting || !captcha.ready}>
        {t("forgotSubmit")}
      </Button>
    </form>
  );
}
