"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { ActivityActionError, closeHome } from "@/activity/api";
import type { AccountChangeAction } from "@/auth/google-reauth";
import { ReauthenticatedAction } from "@/components/account/reauthenticated-action";
import { TextField } from "@/components/ui/text-field";

export interface CloseHomeProps {
  readonly homeId: string;
  readonly homeName: string;
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  readonly confirmed: AccountChangeAction | null;
}

/**
 * Closing a Home (S40, spec "Confirmed Home deletion and recovery"): its Owner types the Home's name
 * and confirms it's them. Every member loses access at once; the Owner lands on their closed Homes,
 * where they can restore it for 30 days. A full page load drops every cached view of the Home.
 */
export function CloseHome({
  homeId,
  homeName,
  email,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
}: CloseHomeProps) {
  const t = useTranslations("Deletion");
  const [typed, setTyped] = useState("");

  return (
    <ReauthenticatedAction
      action="close_home"
      email={email}
      userId={userId}
      twoFactor={twoFactor}
      hasPassword={hasPassword}
      confirmed={confirmed}
      returnPath={`/homes/${homeId}/close`}
      label={t("closeButton")}
      confirmIntro={t("closeConfirmIntro")}
      testId="close-home"
      validate={() => (typed.trim() === homeName ? null : t("closeNameRequired"))}
      perform={async () => {
        try {
          await closeHome(homeId, typed.trim());
          window.location.assign(
            new URL("/settings/closed-homes?status=closed", window.location.origin),
          );
          return { kind: "done" };
        } catch (error) {
          const failure = error instanceof ActivityActionError ? error.failure : "failed";
          if (failure === "reauthenticate") return { kind: "reauthenticate" };
          if (failure === "signedOut") {
            window.location.assign(new URL("/sign-in", window.location.origin));
            return { kind: "done" };
          }
          if (failure === "invalid") return { kind: "message", message: t("closeNameRequired") };
          return { kind: "message", message: t("closeFailed") };
        }
      }}
    >
      <TextField
        label={t("closeNameLabel")}
        description={t("closeNameHint", { home: homeName })}
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
        }}
        data-testid="close-home-name"
      />
    </ReauthenticatedAction>
  );
}
