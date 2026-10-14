"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { classifyAuthError, type AuthFailure } from "@/auth/auth-errors";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";

import { FormAlert } from "./form-alert";
import { useAuthMessages } from "./use-auth-messages";

export interface GoogleSignInProps {
  /** Same-site path to open afterwards, already checked by `safeNextPath` on the server. */
  readonly next: string;
}

/** The callback address for a Google sign-in that should end on `next`. */
export function googleCallbackUrl(origin: string, next: string): string {
  const url = new URL("/auth/callback", origin);
  if (next !== "/") url.searchParams.set("next", next);
  return url.toString();
}

/**
 * "Continue with Google" on the sign-in and sign-up pages (S08). Straight from the browser to
 * Supabase Auth, which sends the person to Google and back to `/auth/callback`. A Google account
 * that is not linked yet creates a new Madeora account; it is never attached to an existing account
 * by its email address (the database refuses that).
 */
export function GoogleSignIn({ next }: GoogleSignInProps) {
  const t = useTranslations("Auth");
  const messages = useAuthMessages();
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);

  async function start() {
    setPending(true);
    setFailure(null);
    const { error } = await getSupabaseBrowserClient().auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: googleCallbackUrl(window.location.origin, next),
        // Google asks which account to use, so a shared device never picks one silently.
        queryParams: { prompt: "select_account" },
      },
    });
    // On success the browser is already on its way to Google.
    if (error) {
      setFailure(classifyAuthError(error));
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {failure ? (
        <FormAlert tone="error" announce>
          {messages.failure(failure)}
        </FormAlert>
      ) : null}
      <Button
        variant="secondary"
        disabled={!hydrated}
        loading={pending}
        onClick={() => {
          void start();
        }}
      >
        {t("continueWithGoogle")}
      </Button>
    </div>
  );
}

/** "or" between the email form and the Google button. */
export function SignInDivider() {
  const t = useTranslations("Auth");
  return (
    <div className="my-5 flex items-center gap-3 text-helper text-fg-muted">
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
      <span>{t("orDivider")}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}
