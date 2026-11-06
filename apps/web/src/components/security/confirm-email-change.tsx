"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { classifyAuthError, type AuthFailure } from "@/auth/auth-errors";
import { getMemoryOnlySupabaseClient } from "@/auth/supabase-browser";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";

export interface ConfirmEmailChangeProps {
  /** The one-time token from the email link, already checked for shape; null when missing. */
  readonly tokenHash: string | null;
}

/**
 * Confirms a new account email (S37) only when the person selects the button, so mail scanners
 * cannot use up the link. The confirmation runs in a memory-only client and its session is signed
 * out at once: the link proves the mailbox, it does not sign anyone in.
 */
export function ConfirmEmailChange({ tokenHash }: ConfirmEmailChangeProps) {
  const t = useTranslations("Security");
  const messages = useAuthMessages();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [done, setDone] = useState(false);

  if (tokenHash === null) {
    return <FormAlert tone="error">{t("emailLinkInvalid")}</FormAlert>;
  }

  async function confirm(token: string) {
    setPending(true);
    setFailure(null);
    const client = getMemoryOnlySupabaseClient("email-change");
    const { error } = await client.auth.verifyOtp({ token_hash: token, type: "email_change" });
    if (error) {
      setFailure(classifyAuthError(error));
      setPending(false);
      return;
    }
    await client.auth.signOut({ scope: "local" });
    setDone(true);
    setPending(false);
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="success" announce>
          {t("emailConfirmed")}
        </FormAlert>
        <Link href="/settings/security" className="text-body font-medium text-accent-fg underline">
          {t("backToSecurity")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-fg">{t("confirmEmailDescription")}</p>
      {failure ? (
        <FormAlert tone="error" announce>
          {failure === "linkInvalid" || failure === "invalidCredentials"
            ? t("emailLinkInvalid")
            : messages.failure(failure)}
        </FormAlert>
      ) : null}
      <Button
        loading={pending}
        onClick={() => {
          void confirm(tokenHash);
        }}
      >
        {t("confirmEmailSubmit")}
      </Button>
    </div>
  );
}
