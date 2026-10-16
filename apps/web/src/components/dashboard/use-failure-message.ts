import { useTranslations } from "next-intl";

import type { DashboardFailure } from "@/dashboard/api";

/** What went wrong with a dashboard or template request, in words the person can act on. */
export function useFailureMessage(): (failure: DashboardFailure) => string {
  const t = useTranslations("Dashboard");
  const messages: { readonly [F in DashboardFailure]: string } = {
    signedOut: t("errorSignedOut"),
    invalid: t("errorInvalid"),
    notFound: t("errorNotFound"),
    notPermitted: t("errorNotPermitted"),
    conflict: t("errorConflict"),
    nothingToUndo: t("errorNothingToUndo"),
    limitReached: t("errorLimitReached"),
    network: t("errorNetwork"),
    failed: t("errorFailed"),
  };
  return (failure) => messages[failure];
}
