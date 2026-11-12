"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { signInChildWithPassword, type ChildSignInFailure } from "@/child-sign-in/api";
import { CHILD_HOME_PATH } from "@/auth/redirects";
import { passwordSignInSchema, type PasswordSignInInput } from "@/child-sign-in/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";

import { ChildSignInFailureText } from "./child-sign-in-failure";

/**
 * A child's username and password sign-in (S42). The server checks everything; a wrong and an
 * unknown username get the same message. The password is cleared after every try.
 */
export function ChildSignInForm() {
  const t = useTranslations("ChildSignIn");
  const hydrated = useHydrated();
  const [failure, setFailure] = useState<ChildSignInFailure | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const form = useForm<PasswordSignInInput>({
    resolver: zodResolver(passwordSignInSchema),
    defaultValues: { username: "", password: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);
    const result = await signInChildWithPassword(values);
    if (result) {
      setFailure(result);
      form.setValue("password", "");
      return;
    }
    // A full page load, so the server checks the new session and every client cache starts empty.
    setRedirecting(true);
    window.location.assign(new URL(CHILD_HOME_PATH, window.location.origin));
  });

  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-5"
      data-testid="child-sign-in-form"
      onSubmit={(event) => {
        void onSubmit(event);
      }}
    >
      <TextField
        label={t("usernameLabel")}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
        error={errors.username ? t("usernameRequired") : undefined}
        {...form.register("username")}
      />
      <TextField
        label={t("passwordLabel")}
        type="password"
        autoComplete="current-password"
        required
        error={errors.password ? t("passwordRequired") : undefined}
        {...form.register("password")}
      />
      {failure ? (
        <FormAlert tone="error" announce>
          <ChildSignInFailureText failure={failure} />
        </FormAlert>
      ) : null}
      <Button type="submit" disabled={!hydrated} loading={isSubmitting || redirecting}>
        {t("signInButton")}
      </Button>
    </form>
  );
}
