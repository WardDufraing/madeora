"use client";

import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import type { RecoveryFailure } from "@/recovery/api";

const messageKey = {
  signedOut: "failSignedOut",
  reauthenticate: "failReauthenticate",
  invalid: "failInvalid",
  notFound: "failNotFound",
  notPermitted: "failNotPermitted",
  alreadyOpen: "failAlreadyOpen",
  alreadyDecided: "failAlreadyDecided",
  notReady: "failNotReady",
  ownerReturned: "failOwnerReturned",
  noLongerValid: "failNoLongerValid",
  nothingOpen: "failNothingOpen",
  notAllowed: "failNotAllowed",
  network: "failNetwork",
  failed: "failFailed",
} as const satisfies Record<RecoveryFailure, string>;

/** Why a recovery action did not happen, announced at once. */
export function RecoveryFailureAlert({ failure }: { readonly failure: RecoveryFailure | null }) {
  const t = useTranslations("Recovery");
  if (!failure) return null;
  return (
    <FormAlert tone="error" announce>
      {t(messageKey[failure])}
    </FormAlert>
  );
}

/** The message for a field's validation key (`tooShort`, `tooLong`, `required`). */
export function useRecoveryFieldError(): (
  key: string | undefined,
  limits: { readonly min: number; readonly max: number },
) => string | undefined {
  const t = useTranslations("Recovery");
  return (key, limits) => {
    if (key === "tooShort") return t("fieldTooShort", { min: limits.min });
    if (key === "tooLong") return t("fieldTooLong", { max: limits.max });
    if (key === "required") return t("fieldRequired");
    return key ? t("failInvalid") : undefined;
  };
}
