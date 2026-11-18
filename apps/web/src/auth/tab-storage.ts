"use client";

import { createContext, useContext } from "react";

/**
 * Per-account drafts this tab keeps in sessionStorage (an unsaved recipe edit, cooking progress).
 * They belong to the person signed in when they were written (S24-L2: a shared device must not
 * offer one person's unsaved changes to the next), so:
 * - each key carries that person's user id (`accountTabKey`), and a page reads only its own;
 * - they go when that person signs out or another account appears in the tab, and a page load for
 *   another account removes them too (`clearOtherAccountsTabStorage`), even when the earlier
 *   session ended without an event in this tab.
 */
const ACCOUNT_PREFIXES = ["madeora:recipe-"] as const;

/** The signed-in account on this page; the app layout provides it. */
export const AccountContext = createContext<string | null>(null);

/** A per-account sessionStorage key: `madeora:recipe-edit:<userId>:<recipeId>`. */
export function accountTabKey(
  kind: "recipe-edit" | "recipe-cook",
  userId: string | null,
  rest: string,
): string {
  return `madeora:${kind}:${userId ?? "none"}:${rest}`;
}

/** The current account's id, for `accountTabKey`; null outside the signed-in app. */
export function useAccountId(): string | null {
  return useContext(AccountContext);
}

function removeKeys(remove: (key: string) => boolean): void {
  try {
    const storage = window.sessionStorage;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && ACCOUNT_PREFIXES.some((prefix) => key.startsWith(prefix)) && remove(key)) {
        keys.push(key);
      }
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // No storage in this tab (private mode, blocked): nothing was kept.
  }
}

/** Removes every account's drafts from this tab. */
export function clearAccountTabStorage(): void {
  removeKeys(() => true);
}

/** Removes the drafts that do not belong to `userId` (and any written without an account). */
export function clearOtherAccountsTabStorage(userId: string): void {
  removeKeys((key) => key.split(":")[2] !== userId);
}
