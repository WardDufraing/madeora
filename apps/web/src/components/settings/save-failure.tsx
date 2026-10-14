"use client";

import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import type { SaveFailure } from "@/preferences/api";

const messageKey = {
  signedOut: "saveSignedOut",
  invalid: "saveInvalid",
  network: "saveNetwork",
  failed: "saveFailed",
} as const satisfies Record<SaveFailure, string>;

/** Why a preferences change was not saved, announced at once. */
export function SaveFailureAlert({ failure }: { readonly failure: SaveFailure | null }) {
  const t = useTranslations("Settings");
  if (!failure) return null;
  return (
    <FormAlert tone="error" announce>
      {t(messageKey[failure])}
    </FormAlert>
  );
}
