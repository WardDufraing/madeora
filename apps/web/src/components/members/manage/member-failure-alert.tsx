"use client";

import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import type { MemberFailure } from "@/members/manage-api";

const messageKey = {
  signedOut: "failSignedOut",
  invalid: "failInvalid",
  notFound: "failNotFound",
  notPermitted: "failNotPermitted",
  stale: "failStale",
  pendingExists: "failPendingExists",
  invalidTarget: "failInvalidTarget",
  ownerMustTransfer: "failOwnerMustTransfer",
  alreadyDecided: "failAlreadyDecided",
  expired: "failExpired",
  noLongerValid: "failNoLongerValid",
  network: "failNetwork",
  failed: "failFailed",
} as const satisfies Record<MemberFailure, string>;

/** Why a member action did not happen, announced at once. */
export function MemberFailureAlert({
  failure,
  className,
}: {
  readonly failure: MemberFailure | null;
  readonly className?: string;
}) {
  const t = useTranslations("Manage");
  if (!failure) return null;
  return (
    <FormAlert tone="error" announce {...(className ? { className } : {})}>
      {t(messageKey[failure])}
    </FormAlert>
  );
}
