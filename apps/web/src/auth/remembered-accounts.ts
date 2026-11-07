import { useMemo, useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * Accounts remembered on this device for switching (S38, spec "Confirmed secure multi-account
 * switching on ordinary shared devices"). Only what the chooser needs to tell accounts apart: the
 * stable id, the person's own display name and accent colour. Never a token, email address,
 * password, Home, notification or anything private: switching always signs the current account out
 * and the next one in with its own sign-in (and two-factor), so nothing here can unlock an account.
 *
 * Browser storage can be unavailable (private windows, blocked storage); every function then
 * behaves as if nothing were remembered.
 */
const STORAGE_KEY = "madeora.remembered-accounts.v1";
/** "no" when the person chose "don't remember me" for this sign-in (this tab only). */
const CHOICE_KEY = "madeora.remember-account";
export const MAX_REMEMBERED_ACCOUNTS = 8;

const rememberedAccountSchema = z.strictObject({
  userId: z.uuid(),
  name: z.string().min(1).max(100).nullable(),
  accent: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullable(),
});
export type RememberedAccount = z.infer<typeof rememberedAccountSchema>;

const listSchema = z.array(rememberedAccountSchema).max(MAX_REMEMBERED_ACCOUNTS);

export function listRememberedAccounts(): RememberedAccount[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = listSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const CHANGED = "madeora:remembered-accounts";

function save(accounts: readonly RememberedAccount[]): void {
  try {
    if (accounts.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
  } catch {
    // Storage blocked: nothing is remembered, which is the safe outcome.
  }
  window.dispatchEvent(new Event(CHANGED));
}

function rawList(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * The remembered accounts, kept current when this tab or another changes them; null while
 * rendering on the server (the list exists only in this browser).
 */
export function useRememberedAccounts(): RememberedAccount[] | null {
  const raw = useSyncExternalStore(subscribe, rawList, () => null);
  return useMemo(() => (raw === null ? null : listRememberedAccounts()), [raw]);
}

/** Adds or refreshes `account`, most recent first; the oldest drops off past the limit. */
export function rememberAccount(account: RememberedAccount): void {
  const parsed = rememberedAccountSchema.safeParse(account);
  if (!parsed.success) return;
  const others = listRememberedAccounts().filter((entry) => entry.userId !== account.userId);
  save([parsed.data, ...others].slice(0, MAX_REMEMBERED_ACCOUNTS));
}

/** Removes the account from this device's list only (the account itself is untouched). */
export function forgetAccount(userId: string): void {
  save(listRememberedAccounts().filter((entry) => entry.userId !== userId));
}

export function setRememberChoice(remember: boolean): void {
  try {
    if (remember) window.sessionStorage.removeItem(CHOICE_KEY);
    else window.sessionStorage.setItem(CHOICE_KEY, "no");
  } catch {
    // Without storage the default (remember) applies, and nothing can be stored anyway.
  }
}

export function rememberChoice(): boolean {
  try {
    return window.sessionStorage.getItem(CHOICE_KEY) !== "no";
  } catch {
    return false;
  }
}
