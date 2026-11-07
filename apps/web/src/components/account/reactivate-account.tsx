"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { ActivityActionError, reactivateAccount } from "@/activity/api";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";

/**
 * "Reactivate my account" (S38). Afterwards the person lands on their Home membership history from
 * the day they left, so they see what changed while they were away.
 */
export function ReactivateAccount() {
  const t = useTranslations("Lifecycle");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function reactivate() {
    setBusy(true);
    setFailed(false);
    try {
      const since = await reactivateAccount();
      const target = new URL("/settings/activity", window.location.origin);
      target.searchParams.set("category", "home_memberships");
      if (since) target.searchParams.set("from", since.slice(0, 10));
      target.searchParams.set("welcome", "back");
      window.location.assign(target);
    } catch (error) {
      if (error instanceof ActivityActionError && error.failure === "signedOut") {
        window.location.assign(new URL("/sign-in", window.location.origin));
        return;
      }
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      {failed ? (
        <FormAlert tone="error" announce>
          {t("reactivateFailed")}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          loading={busy}
          onClick={() => {
            void reactivate();
          }}
        >
          {t("reactivate")}
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
