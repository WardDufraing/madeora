"use client";

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";

import { parseAccentColor } from "@/accent/accent";
import { forgetAccount, useRememberedAccounts } from "@/auth/remembered-accounts";
import { MemberAvatar } from "@/components/members/member-avatar";
import { Button } from "@/components/ui/button";

export interface AccountChooserProps {
  /** The account signed in on this page, confirmed by the server; null when signed out. */
  readonly activeUserId: string | null;
}

/**
 * The account chooser (S38): the accounts remembered on this device with only their name and
 * colour, which one is active, and per account "Switch", or "Remove from this device". Switching
 * and adding sign the active account out on this device first (a full page load, so no cached data,
 * pending request or live subscription of that account survives) and then use the next account's
 * own sign-in, with its two-factor sign-in.
 */
export function AccountChooser({ activeUserId }: AccountChooserProps) {
  const t = useTranslations("Accounts");
  const locale = useLocale();
  const accounts = useRememberedAccounts();

  if (accounts === null) return null;

  const signedIn = activeUserId !== null;
  const ordered = [...accounts].sort(
    (a, b) => Number(b.userId === activeUserId) - Number(a.userId === activeUserId),
  );

  return (
    <div className="flex flex-col gap-5">
      {ordered.length === 0 ? (
        <p className="text-body text-fg-muted">{t("none")}</p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-line"
          aria-label={t("listLabel")}
          data-testid="account-list"
        >
          {ordered.map((account) => {
            const name = account.name ?? t("unnamed");
            const active = account.userId === activeUserId;
            return (
              <li
                key={account.userId}
                className="flex flex-wrap items-center gap-3 py-3"
                data-testid="remembered-account"
              >
                <MemberAvatar
                  name={account.name}
                  accentColor={parseAccentColor(account.accent)}
                  locale={locale}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <bdi className="truncate text-body font-semibold">{name}</bdi>
                  {active ? <span className="text-helper text-fg-muted">{t("active")}</span> : null}
                </span>
                <span className="flex flex-wrap gap-2">
                  {active ? null : signedIn ? (
                    <form method="post" action="/auth/sign-out">
                      <input type="hidden" name="then" value="switch" />
                      <input type="hidden" name="account" value={account.userId} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="secondary"
                        aria-label={t("switchLabel", { name })}
                      >
                        {t("switch")}
                      </Button>
                    </form>
                  ) : (
                    <Link
                      href={`/sign-in?account=${account.userId}`}
                      className="inline-flex items-center rounded-control border border-line px-3 py-1.5 text-helper font-medium"
                      aria-label={t("switchLabel", { name })}
                    >
                      {t("switch")}
                    </Link>
                  )}
                  {active ? (
                    <form
                      method="post"
                      action="/auth/sign-out"
                      onSubmit={() => {
                        forgetAccount(account.userId);
                      }}
                    >
                      <input type="hidden" name="then" value="accounts" />
                      <Button
                        type="submit"
                        size="sm"
                        variant="ghost"
                        aria-label={t("removeLabel", { name })}
                      >
                        {t("remove")}
                      </Button>
                    </form>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("removeLabel", { name })}
                      onClick={() => {
                        forgetAccount(account.userId);
                      }}
                    >
                      {t("remove")}
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        {signedIn ? (
          <form method="post" action="/auth/sign-out">
            <input type="hidden" name="then" value="switch" />
            <Button type="submit" variant="secondary" data-testid="add-account">
              {t("add")}
            </Button>
          </form>
        ) : (
          <Link href="/sign-in" className="font-medium text-accent-fg underline">
            {t("add")}
          </Link>
        )}
      </div>
    </div>
  );
}
