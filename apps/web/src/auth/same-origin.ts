/**
 * CSRF check for cookie-authenticated mutations (architecture.md §7, §21).
 *
 * A browser always sends `Origin` on a cross-site POST, and a page on another site cannot forge it
 * or the `Host` it is sent to. So a mutation is accepted only when its `Origin` is this site: the
 * host the request was sent to, or the configured app address. Without `Origin`, the browser's
 * `Sec-Fetch-Site: same-origin` is accepted; with neither, the request is refused.
 */
export function isSameOriginRequest(headers: Headers, appUrl: string): boolean {
  const origin = headers.get("origin");
  if (origin === null) return headers.get("sec-fetch-site") === "same-origin";
  if (origin === "null") return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") return false;
  if (origin === new URL(appUrl).origin) return true;

  // On Vercel the request may arrive on a deployment address other than NEXT_PUBLIC_APP_URL.
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  return host !== null && host.toLowerCase() === originUrl.host.toLowerCase();
}
