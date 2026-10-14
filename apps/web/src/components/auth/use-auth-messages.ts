"use client";

import { useTranslations } from "next-intl";

import type { AuthFailure } from "@/auth/auth-errors";
import type { AuthFieldError } from "@/auth/schemas";

/** Translated texts for validation errors (from the Zod schemas) and Supabase Auth failures. */
export function useAuthMessages(): {
  readonly field: (key: string | undefined) => string | undefined;
  readonly failure: (key: AuthFailure) => string;
} {
  const t = useTranslations("Auth");
  const fields: Record<AuthFieldError, string> = {
    emailRequired: t("emailRequired"),
    emailInvalid: t("emailInvalid"),
    passwordRequired: t("passwordRequired"),
    passwordTooShort: t("passwordTooShort"),
    passwordTooLong: t("passwordTooLong"),
    passwordIsEmail: t("passwordIsEmail"),
    passwordsDiffer: t("passwordsDiffer"),
  };
  const failures: Record<AuthFailure, string> = {
    invalidCredentials: t("invalidCredentials"),
    emailNotConfirmed: t("emailNotConfirmed"),
    rateLimited: t("rateLimited"),
    weakPassword: t("weakPassword"),
    samePassword: t("samePassword"),
    linkInvalid: t("linkInvalid"),
    network: t("network"),
    unknown: t("unknown"),
  };
  return {
    field: (key) => {
      if (key === undefined) return undefined;
      return key in fields ? fields[key as AuthFieldError] : failures.unknown;
    },
    failure: (key) => failures[key],
  };
}
