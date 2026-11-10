"use client";

import { useTranslations } from "next-intl";

import { ActivityActionError, restoreHome } from "@/activity/api";
import type { AccountChangeAction } from "@/auth/google-reauth";
import { ReauthenticatedAction } from "@/components/account/reauthenticated-action";

export interface RestoreHomeProps {
  readonly homeId: string;
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  readonly confirmed: AccountChangeAction | null;
}

/**
 * Restoring a closed Home before its deadline (S40): its Owner confirms it's them. Members, roles,
 * content and settings come back; invitations don't. The page opens the Home with a full load.
 */
export function RestoreHome({
  homeId,
  email,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
}: RestoreHomeProps) {
  const t = useTranslations("Deletion");
  return (
    <ReauthenticatedAction
      action="close_home"
      email={email}
      userId={userId}
      twoFactor={twoFactor}
      hasPassword={hasPassword}
      confirmed={confirmed}
      returnPath="/settings/closed-homes"
      label={t("restoreButton")}
      confirmIntro={t("restoreConfirmIntro")}
      variant="primary"
      testId={`restore-home-${homeId}`}
      perform={async () => {
        try {
          await restoreHome(homeId);
          window.location.assign(new URL(`/homes/${homeId}`, window.location.origin));
          return { kind: "done" };
        } catch (error) {
          const failure = error instanceof ActivityActionError ? error.failure : "failed";
          if (failure === "reauthenticate") return { kind: "reauthenticate" };
          if (failure === "signedOut") {
            window.location.assign(new URL("/sign-in", window.location.origin));
            return { kind: "done" };
          }
          if (failure === "expired") return { kind: "message", message: t("restoreExpired") };
          return { kind: "message", message: t("restoreFailed") };
        }
      }}
    />
  );
}
