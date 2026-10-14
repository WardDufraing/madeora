"use client";

import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import type { InvitationFailure } from "@/invitations/api";

const messageKey = {
  signedOut: "failSignedOut",
  invalid: "failInvalid",
  notFound: "failNotFound",
  notPermitted: "failNotPermitted",
  limitReached: "failLimitReached",
  duplicateEmail: "failDuplicateEmail",
  notActive: "failNotActive",
  hasRequest: "failHasRequest",
  rateLimited: "failRateLimited",
  alreadyDecided: "failAlreadyDecided",
  noLongerValid: "failNoLongerValid",
  alreadyMember: "failAlreadyMember",
  notPending: "failNotPending",
  network: "failNetwork",
  failed: "failFailed",
} as const satisfies Record<InvitationFailure, string>;

/** Why an invitation action did not happen, announced at once. */
export function InvitationFailureAlert({
  failure,
  className,
}: {
  readonly failure: InvitationFailure | null;
  readonly className?: string;
}) {
  const t = useTranslations("Invitations");
  if (!failure) return null;
  return (
    <FormAlert tone="error" announce {...(className ? { className } : {})}>
      {t(messageKey[failure])}
    </FormAlert>
  );
}
