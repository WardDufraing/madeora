"use client";

import { useFormatter, useTranslations } from "next-intl";

import type { ChildSignInFailure } from "@/child-sign-in/api";

/**
 * Why a child's sign-in did not work, in words a child can follow and without revealing whether a
 * username exists or which part was wrong.
 */
export function ChildSignInFailureText({ failure }: { readonly failure: ChildSignInFailure }) {
  const t = useTranslations("ChildSignIn");
  const format = useFormatter();
  switch (failure.kind) {
    case "invalidCredentials":
      return t("failInvalid");
    case "locked":
      return failure.until === null
        ? t("failLockedGuardian")
        : t("failLocked", {
            time: format.dateTime(new Date(failure.until), { timeStyle: "short" }),
          });
    case "rateLimited":
      return t("failRateLimited");
    case "notEnabled":
      return t("failNotEnabled");
    case "deviceNotApproved":
      return t("failDeviceNotApproved");
    case "signedIn":
      return t("failSignedIn");
    case "network":
      return t("failNetwork");
    case "failed":
      return t("failFailed");
  }
}
