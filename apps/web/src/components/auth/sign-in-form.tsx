"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { classifyAuthError, type AuthFailure } from "@/auth/auth-errors";
import { signInSchema, type SignInValues } from "@/auth/schemas";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";

import { FormAlert } from "./form-alert";
import { ResendConfirmation } from "./resend-confirmation";
import { useAuthMessages } from "./use-auth-messages";

export interface SignInFormProps {
  /** Same-site path to open afterwards, already checked by `safeNextPath` on the server. */
  readonly next: string;
}

export function SignInForm({ next }: SignInFormProps) {
  const t = useTranslations("Auth");
  const hydrated = useHydrated();
  const messages = useAuthMessages();
  const [failure, setFailure] = useState<{ kind: AuthFailure; email: string } | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const form = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);
    // Straight from the browser to Supabase Auth, which rate-limits per visitor IP (ADR 0007).
    const { error } = await getSupabaseBrowserClient().auth.signInWithPassword(values);
    if (error) {
      setFailure({ kind: classifyAuthError(error), email: values.email });
      form.setValue("password", "");
      return;
    }
    // A full page load, so the server checks the new session and every client cache starts empty.
    setRedirecting(true);
    window.location.assign(new URL(next, window.location.origin));
  });

  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        noValidate
        onSubmit={(event) => {
          void onSubmit(event);
        }}
        className="flex flex-col gap-4"
      >
        {failure ? (
          <FormAlert tone="error" announce>
            {messages.failure(failure.kind)}
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
        <TextField
          label={t("passwordLabel")}
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          required
          error={messages.field(errors.password?.message)}
          {...form.register("password")}
        />
        <Checkbox
          label={t("showPassword")}
          checked={showPassword}
          onChange={(event) => {
            setShowPassword(event.target.checked);
          }}
        />
        <Button type="submit" disabled={!hydrated} loading={isSubmitting || redirecting}>
          {t("signInSubmit")}
        </Button>
      </form>
      {failure?.kind === "emailNotConfirmed" ? <ResendConfirmation email={failure.email} /> : null}
    </div>
  );
}
