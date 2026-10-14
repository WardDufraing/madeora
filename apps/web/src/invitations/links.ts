import { getPublicEnv } from "@madeora/config/env/public";

/**
 * The address of an invitation link or join code: always the configured app address
 * (`NEXT_PUBLIC_APP_URL`), never the address the request came in on, like the auth email links
 * (ADR 0007). The secret is in the path, so the page can read it without a query string.
 */
export function joinUrl(token: string): string {
  return new URL(
    `/join/${encodeURIComponent(token)}`,
    getPublicEnv().NEXT_PUBLIC_APP_URL,
  ).toString();
}
