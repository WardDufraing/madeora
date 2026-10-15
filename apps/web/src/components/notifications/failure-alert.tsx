"use client";

import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import type { NotificationFailure } from "@/notifications/api";

const messageKey = {
  signedOut: "saveSignedOut",
  invalid: "saveInvalid",
  notFound: "saveNotFound",
  network: "saveNetwork",
  failed: "saveFailed",
} as const satisfies Record<NotificationFailure, string>;

/** Why a notification setting was not saved, announced at once. */
export function NotificationFailureAlert({
  failure,
}: {
  readonly failure: NotificationFailure | null;
}) {
  const t = useTranslations("NotificationSettings");
  if (!failure) return null;
  return (
    <FormAlert tone="error" announce>
      {t(messageKey[failure])}
    </FormAlert>
  );
}
