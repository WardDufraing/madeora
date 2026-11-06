"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";

export interface ConfirmBackupEmailProps {
  /** The link's token, already checked for shape; null when missing or malformed. */
  readonly token: string | null;
}

type Outcome = "confirmed" | "invalid" | "unavailable" | "failed";

/**
 * Confirms a new backup address (S37) for the signed-in account, only when the person selects
 * the button, so mail scanners cannot use up the link.
 */
export function ConfirmBackupEmail({ token }: ConfirmBackupEmailProps) {
  const t = useTranslations("Security");
  const messages = useAuthMessages();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (token === null || outcome === "invalid") {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="error">{t("backupLinkInvalid")}</FormAlert>
        <BackLink />
      </div>
    );
  }

  async function confirm(value: string) {
    setPending(true);
    const { data, error } = await getSupabaseBrowserClient().rpc("confirm_backup_email", {
      p_token: value,
    });
    setPending(false);
    if (error) setOutcome("failed");
    else if (data === "confirmed" || data === "unavailable") setOutcome(data);
    else setOutcome("invalid");
  }

  if (outcome === "confirmed" || outcome === "unavailable") {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone={outcome === "confirmed" ? "success" : "error"} announce>
          {outcome === "confirmed" ? t("backupConfirmed") : t("backupUnavailable")}
        </FormAlert>
        <BackLink />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-fg">{t("confirmBackupDescription")}</p>
      {outcome === "failed" ? (
        <FormAlert tone="error" announce>
          {messages.failure("unknown")}
        </FormAlert>
      ) : null}
      <Button
        loading={pending}
        onClick={() => {
          void confirm(token);
        }}
      >
        {t("confirmBackupSubmit")}
      </Button>
    </div>
  );
}

function BackLink() {
  const t = useTranslations("Security");
  return (
    <Link
      href="/settings/security#recovery"
      className="text-body font-medium text-accent-fg underline"
    >
      {t("backToSecurity")}
    </Link>
  );
}
