"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";

export interface RecoveryBannerProps {
  /** When the waiting period ends (formatted), or null once it has. */
  readonly waitingUntil: string | null;
  readonly ready: boolean;
}

/**
 * An account recovery is under way (S37): someone used the backup address and an account
 * recovery code. The signed-in owner can stop it at once, without reauthentication.
 */
export function RecoveryBanner({ waitingUntil, ready }: RecoveryBannerProps) {
  const t = useTranslations("Security");
  const authMessages = useAuthMessages();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function stop() {
    setBusy(true);
    setFailure(null);
    const { error } = await getSupabaseBrowserClient().rpc("cancel_account_recovery");
    if (error) {
      setBusy(false);
      setFailure(authMessages.failure("unknown"));
      return;
    }
    window.location.assign(
      new URL("/settings/security?recovery=cancelled", window.location.origin),
    );
  }

  return (
    <div
      role="region"
      aria-label={t("recoveryUnderwayTitle")}
      className="flex flex-col gap-3 rounded-card border border-danger p-4"
      data-testid="recovery-banner"
    >
      <p className="text-body font-semibold">{t("recoveryUnderwayTitle")}</p>
      <p className="text-body">
        {ready || waitingUntil === null
          ? t("recoveryUnderwayReady")
          : t("recoveryUnderwayWaiting", { date: waitingUntil })}
      </p>
      {failure ? (
        <FormAlert tone="error" announce>
          {failure}
        </FormAlert>
      ) : null}
      <div>
        <Button variant="destructive" loading={busy} onClick={() => void stop()}>
          {t("stopRecovery")}
        </Button>
      </div>
    </div>
  );
}
