"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ActivityActionError, respondToSignIn, type SignInResponseResult } from "@/activity/api";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";

export interface SignInResponseProps {
  readonly eventId: string;
  readonly response: "confirmed" | "reported" | null;
  /** Names the sign-in for screen readers ("Signed in, 07/11/2026 10:52, Safari on iPhone"). */
  readonly label: string;
}

/**
 * "This was me" / "Secure my account" on a sign-in (spec: risk-based account security
 * notifications, user action). Securing signs that session out when it is still signed in
 * elsewhere, records a suspicious-session report and points to the password and session controls;
 * it never deletes content or changes Home memberships.
 */
export function SignInResponse({ eventId, response, label }: SignInResponseProps) {
  const t = useTranslations("Activity");
  const router = useRouter();
  const [busy, setBusy] = useState<"confirmed" | "reported" | null>(null);
  const [result, setResult] = useState<SignInResponseResult | null>(null);
  const [failed, setFailed] = useState(false);

  async function answer(choice: "confirmed" | "reported") {
    setBusy(choice);
    setFailed(false);
    try {
      setResult(await respondToSignIn(eventId, choice));
      router.refresh();
    } catch (error) {
      if (error instanceof ActivityActionError && error.failure === "signedOut") {
        window.location.assign(new URL("/sign-in", window.location.origin));
        return;
      }
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  if (result) {
    return (
      <div className="mt-1 flex flex-col gap-2">
        <FormAlert tone={result === "confirmed" ? "success" : "info"} announce>
          {result === "confirmed"
            ? t("confirmedNotice")
            : result === "signed_out"
              ? t("signedOutNotice")
              : t("reportedNotice")}
        </FormAlert>
        {result === "confirmed" ? null : <SecureLinks />}
      </div>
    );
  }

  if (response) {
    return (
      <p className="text-helper text-fg-muted">
        {response === "confirmed" ? t("confirmedLabel") : t("reportedLabel")}
      </p>
    );
  }

  return (
    <div className="mt-1 flex flex-col gap-2">
      {failed ? (
        <FormAlert tone="error" announce>
          {t("respondFailed")}
        </FormAlert>
      ) : null}
      <div role="group" aria-label={label} className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={busy === "confirmed"}
          disabled={busy !== null}
          onClick={() => {
            void answer("confirmed");
          }}
        >
          {t("confirmSignIn")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={busy === "reported"}
          disabled={busy !== null}
          onClick={() => {
            void answer("reported");
          }}
        >
          {t("secureAccount")}
        </Button>
      </div>
    </div>
  );
}

function SecureLinks() {
  const t = useTranslations("Activity");
  return (
    <p className="flex flex-wrap gap-4 text-helper">
      <Link href="/settings/security#password" className="font-medium text-accent-fg underline">
        {t("changePasswordLink")}
      </Link>
      <Link href="/settings/security#sessions" className="font-medium text-accent-fg underline">
        {t("reviewSessionsLink")}
      </Link>
    </p>
  );
}
