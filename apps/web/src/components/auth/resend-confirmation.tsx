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

export interface ResendConfirmationProps {
  /** The address to resend to. Without it, the form asks for one. */
  readonly email?: string;
}

/**
 * Sends the confirmation email again. The answer is the same whether or not the address has an
 * account, or one that still needs confirming (no account enumeration).
 */
export function ResendConfirmation({ email }: ResendConfirmationProps) {
  const t = useTranslations("Auth");
  const messages = useAuthMessages();
  const [result, setResult] = useState<"sent" | AuthFailure | null>(null);
  const form = useForm<EmailOnlyValues>({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: email ?? "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setResult(null);
    const { error } = await getMemoryOnlySupabaseClient("email-requests").auth.resend({
      type: "signup",
      email: values.email,
      options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
    });
    const failure = error ? classifyAuthError(error) : null;
    // Only failures that say nothing about the account are shown; anything else reads as "sent".
    setResult(failure === "rateLimited" || failure === "network" ? failure : "sent");
  });

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-4"
    >
      {email === undefined ? (
        <TextField
          label={t("emailLabel")}
          type="email"
          autoComplete="email"
          required
          error={messages.field(form.formState.errors.email?.message)}
          {...form.register("email")}
        />
      ) : null}
      <Button type="submit" variant="secondary" loading={form.formState.isSubmitting}>
        {t("resendSubmit")}
      </Button>
      {result === "sent" ? (
        <FormAlert tone="success" announce>
          {t("resendSent")}
        </FormAlert>
      ) : result ? (
        <FormAlert tone="error" announce>
          {messages.failure(result)}
        </FormAlert>
      ) : null}
    </form>
  );
}
