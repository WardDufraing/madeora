"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import { classifyAuthError, hidesAccountExistence, type AuthFailure } from "@/auth/auth-errors";
import { signUpSchema, type SignUpValues } from "@/auth/schemas";
import { emailLinkTarget } from "@/auth/email-links";
import { getMemoryOnlySupabaseClient } from "@/auth/supabase-browser";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";

import { useCaptcha } from "./captcha";
import { FormAlert } from "./form-alert";
import { ResendConfirmation } from "./resend-confirmation";
import { useAuthMessages } from "./use-auth-messages";

/**
 * Registration with email and password. Afterwards it always shows "check your email": Supabase
 * Auth answers an already-registered address like a new one when confirmation is on, and the few
 * answers that could still tell them apart get the same message (`hidesAccountExistence`), so the
 * page reveals nothing about existing accounts (spec: no account enumeration).
 */
export function SignUpForm() {
  const t = useTranslations("Auth");
  const hydrated = useHydrated();
  const messages = useAuthMessages();
  const captcha = useCaptcha("sign-up");
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const form = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { email: "", password: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    // Turnstile has no token yet (the button shows busy); Supabase Auth would refuse the request.
    if (!captcha.ready) return;
    setFailure(null);
    const { error } = await getMemoryOnlySupabaseClient("email-requests").auth.signUp({
      email: values.email,
      password: values.password,
      options: {
        emailRedirectTo: emailLinkTarget("/auth/confirm"),
        ...captcha.options,
      },
    });
    captcha.reset();
    if (error && !hidesAccountExistence(error)) {
      setFailure(classifyAuthError(error));
      return;
    }
    setSentTo(values.email);
  });

  // The form is replaced by the "check your email" message: move focus to its heading.
  useEffect(() => {
    if (sentTo !== null) headingRef.current?.focus();
  }, [sentTo]);

  if (sentTo !== null) {
    return (
      <div className="flex flex-col gap-4">
        <h2 ref={headingRef} tabIndex={-1} className="text-section-title font-semibold">
          {t("checkEmailTitle")}
        </h2>
        <p className="text-body text-fg">{t("checkEmailDescription", { email: sentTo })}</p>
        <p className="text-helper text-fg-muted">{t("checkEmailSpam")}</p>
        <ResendConfirmation email={sentTo} />
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
      <TextField
        label={t("passwordLabel")}
        description={t("passwordHint")}
        type={showPassword ? "text" : "password"}
        autoComplete="new-password"
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
      {captcha.check}
      <Button type="submit" disabled={!hydrated} loading={isSubmitting || !captcha.ready}>
        {t("signUpSubmit")}
      </Button>
    </form>
  );
}
