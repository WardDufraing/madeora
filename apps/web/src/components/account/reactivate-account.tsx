"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { ActivityActionError, reactivateAccount } from "@/activity/api";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";

export interface ReactivateAccountProps {
  /** S40: the account is pending deletion; this cancels the deletion. */
  readonly deletion?: boolean;
}

/**
 * "Reactivate my account" (S38), or "Cancel deletion" for an account pending deletion (S40).
 * Afterwards the person lands on their Home membership history from the day they left, so they see
 * what changed while they were away.
 */
export function ReactivateAccount({ deletion = false }: ReactivateAccountProps) {
  const t = useTranslations("Lifecycle");
  const tDeletion = useTranslations("Deletion");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"failed" | "expired" | null>(null);

  async function reactivate() {
    setBusy(true);
    setFailed(null);
    try {
      const since = await reactivateAccount();
      // Reactivation ended this session: signing in again opens a fresh one, then shows what
      // changed in the person's Homes while they were away.
      const changes = new URLSearchParams({ category: "home_memberships" });
      if (since) changes.set("from", since.slice(0, 10));
      changes.set("welcome", "back");
      const target = new URL("/sign-in", window.location.origin);
      target.searchParams.set("status", deletion ? "deletion_canceled" : "reactivated");
      target.searchParams.set("next", `/settings/activity?${changes.toString()}`);
      window.location.assign(target);
    } catch (error) {
      if (error instanceof ActivityActionError && error.failure === "signedOut") {
        window.location.assign(new URL("/sign-in", window.location.origin));
        return;
      }
      setFailed(
        error instanceof ActivityActionError && error.failure === "expired" ? "expired" : "failed",
      );
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      {failed ? (
        <FormAlert tone="error" announce>
          {failed === "expired" ? tDeletion("recoverExpired") : t("reactivateFailed")}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          loading={busy}
          onClick={() => {
            void reactivate();
          }}
        >
          {deletion ? tDeletion("recoverButton") : t("reactivate")}
        </Button>
        <form method="post" action="/auth/sign-out">
          <Button type="submit" variant="ghost">
            {t("notNow")}
          </Button>
        </form>
      </div>
    </div>
  );
}
