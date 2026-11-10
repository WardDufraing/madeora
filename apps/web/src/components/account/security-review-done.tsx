"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ActivityActionError, completeSecurityReview } from "@/activity/api";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";

/** "Everything looks right" at the end of the security review (S38). */
export function SecurityReviewDone() {
  const t = useTranslations("Lifecycle");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"done" | "failed" | null>(null);

  async function done() {
    setBusy(true);
    setStatus(null);
    try {
      await completeSecurityReview();
      setStatus("done");
      router.refresh();
    } catch (error) {
      if (error instanceof ActivityActionError && error.failure === "signedOut") {
        window.location.assign(new URL("/sign-in", window.location.origin));
        return;
      }
      setStatus("failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {status === "done" ? (
        <FormAlert tone="success" announce>
          {t("reviewDoneNotice")}
        </FormAlert>
      ) : null}
      {status === "failed" ? (
        <FormAlert tone="error" announce>
          {t("reviewFailed")}
        </FormAlert>
      ) : null}
      <div>
        <Button
          loading={busy}
          onClick={() => {
            void done();
          }}
        >
          {t("reviewDone")}
        </Button>
      </div>
    </div>
  );
}
