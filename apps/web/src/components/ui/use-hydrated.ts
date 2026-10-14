"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/**
 * `false` in the server render and until React has hydrated this page in the browser, `true`
 * afterwards. Forms that send credentials keep their submit button disabled until then: a form
 * submitted before hydration would fall back to the browser's default (a GET to the same page),
 * putting the email address and password in the page address. Those forms also declare
 * `method="post"`, so a submission that still slips through (a script calling `requestSubmit()`)
 * sends its fields in the request body, never in the address.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
