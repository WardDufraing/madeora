"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { classifyAuthError, type AuthFailure } from "@/auth/auth-errors";
import { emailOnlySchema, type EmailOnlyValues } from "@/auth/schemas";
import { getMemoryOnlySupabaseClient } from "@/auth/supabase-browser";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";

import { FormAlert } from "./form-alert";
import { useAuthMessages } from "./use-auth-messages";

/** Asks for a reset link. The answer never says whether the address has an account. */
export function ForgotPasswordForm() {
  const t = useTranslations("Auth");
  const messages = useAuthMessages();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const form = useForm<EmailOnlyValues>({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);
    setSentTo(null);
    const { error } = await getMemoryOnlySupabaseClient(
      "email-requests",
    ).auth.resetPasswordForEmail(values.email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    const kind = error ? classifyAuthError(error) : null;
    // Rate limits and connection problems say nothing about the account; anything else reads as sent.
    if (kind === "rateLimited" || kind === "network") setFailure(kind);
    else setSentTo(values.email);
  });

  return (
    <form
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
      <Button type="submit" loading={isSubmitting}>
        {t("forgotSubmit")}
      </Button>
    </form>
  );
}
