"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ActivityActionError, requestAccountDeletion } from "@/activity/api";
import { ACCOUNT_DELETION_PHRASES } from "@/activity/schema";
import type { AccountChangeAction } from "@/auth/google-reauth";
import { FormAlert } from "@/components/auth/form-alert";
import { ReauthenticatedAction } from "@/components/account/reauthenticated-action";
import { TextField } from "@/components/ui/text-field";

export interface DeletionBlocker {
  readonly homeId: string;
  readonly homeName: string;
}

export interface DeleteAccountProps {
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  readonly confirmed: AccountChangeAction | null;
  readonly blockers: readonly DeletionBlocker[];
}

/**
 * Account deletion (S40, spec "Confirmed Madeora account deletion and recovery"): every Home the
 * person owns must get another Owner (or be closed) first; then the confirmation word, then a fresh
 * "confirm it's you". Afterwards every session has ended and this browser goes to the sign-in page
 * with a full page load, so nothing of the account stays in memory.
 */
export function DeleteAccount({
  email,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
  blockers,
}: DeleteAccountProps) {
  const t = useTranslations("Deletion");
  const router = useRouter();
  const [phrase, setPhrase] = useState("");

  if (blockers.length > 0) {
    return (
      <div className="flex flex-col gap-3" data-testid="account-deletion-blocked">
        <FormAlert tone="info">{t("accountBlockedIntro")}</FormAlert>
        <ul className="flex flex-col gap-2">
          {blockers.map((blocker) => (
            <li key={blocker.homeId} className="text-body">
              <bdi className="font-semibold">{blocker.homeName}</bdi>{" "}
              <Link
                href={`/homes/${blocker.homeId}/leave`}
                className="font-medium text-accent-fg underline"
              >
                {t("accountBlockedLink")}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <ReauthenticatedAction
      action="delete_account"
      email={email}
      userId={userId}
      twoFactor={twoFactor}
      hasPassword={hasPassword}
      confirmed={confirmed}
      label={t("accountDelete")}
      confirmIntro={t("accountConfirmIntro")}
      testId="delete-account"
      validate={() =>
        (ACCOUNT_DELETION_PHRASES as readonly string[]).includes(phrase.trim())
          ? null
          : t("accountPhraseRequired")
      }
      perform={async () => {
        try {
          await requestAccountDeletion(phrase.trim());
          window.location.assign(
            new URL("/sign-in?status=deletion_requested", window.location.origin),
          );
          return { kind: "done" };
        } catch (error) {
          const failure = error instanceof ActivityActionError ? error.failure : "failed";
          if (failure === "reauthenticate") return { kind: "reauthenticate" };
          if (failure === "signedOut") {
            window.location.assign(new URL("/sign-in", window.location.origin));
            return { kind: "done" };
          }
          if (failure === "soleOwner") {
            router.refresh();
            return { kind: "message", message: t("accountSoleOwner") };
          }
          return { kind: "message", message: t("accountFailed") };
        }
      }}
    >
      <TextField
        label={t("accountPhraseLabel")}
        description={t("accountPhraseHint")}
        autoComplete="off"
        spellCheck={false}
        value={phrase}
        onChange={(event) => {
          setPhrase(event.target.value);
        }}
        data-testid="delete-account-phrase"
      />
    </ReauthenticatedAction>
  );
}
