"use client";

import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import type { HomeSaveFailure } from "@/homes/api";

const messageKey = {
  signedOut: "saveSignedOut",
  invalid: "saveInvalid",
  notFound: "saveNotFound",
  notPermitted: "saveNotPermitted",
  network: "saveNetwork",
  failed: "saveFailed",
} as const satisfies Record<HomeSaveFailure, string>;

/** Why a Home change was not saved, announced at once. */
export function HomeSaveFailureAlert({ failure }: { readonly failure: HomeSaveFailure | null }) {
  const t = useTranslations("Homes");
  if (!failure) return null;
  return (
    <FormAlert tone="error" announce>
      {t(messageKey[failure])}
    </FormAlert>
  );
}
