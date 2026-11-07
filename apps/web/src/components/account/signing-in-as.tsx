"use client";

import { useTranslations } from "next-intl";

import { useRememberedAccounts } from "@/auth/remembered-accounts";
import { FormAlert } from "@/components/auth/form-alert";

/**
 * On the sign-in page after choosing an account on the chooser (S38): names the account to sign in
 * to. Read from this device only; nothing is pre-filled and nothing is unlocked.
 */
export function SigningInAs({ userId }: { readonly userId: string }) {
  const t = useTranslations("Accounts");
  const account = useRememberedAccounts()?.find((entry) => entry.userId === userId);
  if (!account) return null;
  const name = account.name ?? t("unnamed");
  return (
    <FormAlert tone="info" className="mb-4">
      <span>
        {t("signingInAs")} <bdi className="font-semibold">{name}</bdi>
      </span>
    </FormAlert>
  );
}
