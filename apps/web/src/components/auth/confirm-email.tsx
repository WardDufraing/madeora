"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { classifyAuthError, type AuthFailure } from "@/auth/auth-errors";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { Button } from "@/components/ui/button";

import { FormAlert } from "./form-alert";
import { ResendConfirmation } from "./resend-confirmation";
import { useAuthMessages } from "./use-auth-messages";

export interface ConfirmEmailProps {
  /** The one-time token from the email link, already checked for shape; null when missing. */
  readonly tokenHash: string | null;
}

/**
 * Confirms the address only when the person selects the button. Mail scanners that open links
 * automatically therefore cannot use up the one-time token.
 */
export function ConfirmEmail({ tokenHash }: ConfirmEmailProps) {
  const t = useTranslations("Auth");
  const messages = useAuthMessages();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);

  if (tokenHash === null) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="error">{t("confirmMissingToken")}</FormAlert>
        <ResendConfirmation />
      </div>
    );
  }

  async function confirm(token: string) {
    setPending(true);
    setFailure(null);
    const { error } = await getSupabaseBrowserClient().auth.verifyOtp({
      token_hash: token,
      type: "email",
    });
    if (error) {
      setFailure(classifyAuthError(error));
      setPending(false);
      return;
    }
    window.location.assign(new URL("/", window.location.origin));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-fg">{t("confirmDescription")}</p>
      {failure ? (
        <FormAlert tone="error" announce>
          {messages.failure(failure === "invalidCredentials" ? "linkInvalid" : failure)}
        </FormAlert>
      ) : null}
      {failure === "linkInvalid" || failure === "invalidCredentials" ? (
        <ResendConfirmation />
      ) : (
        <Button
          loading={pending}
          onClick={() => {
            void confirm(tokenHash);
          }}
        >
          {t("confirmSubmit")}
        </Button>
      )}
    </div>
  );
}
